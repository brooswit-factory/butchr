/**
 * FACTORY-662 — the rules-specific write orchestration: ties the registry
 * (`./rules-write-registry.ts`), the patch applier (`./rules-write-apply.ts`)
 * and FACTORY-658's write core (`./write-rules.ts`) together into the three
 * operations this slice ships: toggling `enabled`, editing the nested
 * allowlist (`PUT /api/rules/:id`), and a report-only blast-radius plan
 * (`POST /api/rules/plan`). `src/web/view.ts` wires these to HTTP; nothing
 * in this file knows about Elysia, Origin headers, or CSRF — those are
 * `./write-guard.ts`'s job, already run before any of these are called.
 *
 * EVERY WRITE'S CURRENT STATE IS CHECKED INSIDE THE MUTATOR, under the SAME
 * lock `updateRulesFile` (FACTORY-658 finding F1) already takes for its
 * read — never a separate read-then-decide step outside the lock, which
 * would reopen exactly the TOCTOU window F1 exists to close. A refusal
 * (stale etag, non-`ui-` id, a fixed field in the diff, a placeholder
 * query, a stale/missing plan hash, a stop/restart without confirm) throws
 * from inside the mutator, which `updateRulesFile` propagates with NOTHING
 * written — same "throws, writes nothing" contract `writeRulesFile` itself
 * documents for a doomed call.
 *
 * AGENTSAFETY FIRST-PASS FIXES (2026-10-06, on PR #647):
 *   B2 — `POST /api/undo/:backupId` no longer restores ANY backup: it
 *   restores ONLY the backup id this SAME process's last successful UI
 *   write produced, and ONLY while the file's etag is still that write's
 *   own resulting etag (`RulesWriteDeps.lastUiWrite`, a mutable ref the
 *   caller keeps alive across calls). An admin's hand edit (or anyone
 *   else's write) between the UI write and the undo changes the etag and
 *   refuses it — undo can never revert someone else's unrelated change,
 *   and can never reach a backup from before the most recent UI write.
 *   B3 — apply is now bound to a plan: `writeRuleEnabled`/`writeRuleFields`
 *   require a `planHash` (echoed from a fresh `planRuleWrite` call) and
 *   recompute the SAME hash themselves, under the lock, over the exact
 *   next-document text plus the computed spawn/stop/restart counts —
 *   a stale plan (the file changed since) or a tampered one is refused.
 *   Any plan with `stopped`/`restarted` above zero additionally requires
 *   `confirm: true` — the bug this closes: disabling a running rule or
 *   editing an enabled rule's query/preferences silently restarted/stopped
 *   an agent with no confirmation at all.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { updateRulesFile, restoreBackup, rulesEtag, type WriteRulesIo, type WriteRulesResult } from "./write-rules.js";
import { rulesPath, type RulesEnv } from "./rules.js";
import { applyRuleFieldPatch, readRuleById, buildEnabledAllowedPaths, buildFieldsAllowedPaths, RuleWriteApplyError } from "./rules-write-apply.js";
import { isUiEditableRuleId, PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING, type RuleFieldPatch } from "./rules-write-registry.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export class WriteRefusedError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** B2's own tracking ref — mutated by `writeRuleEnabled`/`writeRuleFields` on success, consulted (and cleared) by `writeUndo`. The SAME object must be passed on every call for a given daemon process (see `RulesWriteDeps.lastUiWrite`'s own doc comment) — a fresh ref (as a test that doesn't care about undo gets by default) means undo is refused until a write happens through that exact ref. */
export interface LastUiWriteRef {
  value: { backupId: string; resultingEtag: string } | null;
}

export interface RulesWriteDeps {
  env?: RulesEnv;
  io?: WriteRulesIo;
  /**
   * FACTORY-657's reload (merged, PR #645) — `src/daemon/index.ts` wires
   * this to `() => reloadRulesNow()` (literally `reloadRules(rulesHolder)`,
   * the SAME function `SIGHUP` calls), so a web write's reload and a
   * SIGHUP's reload can never drift. The default stub below (only reached
   * by a test that doesn't supply one) reports "applied" without swapping
   * anything.
   */
  reload?: () => { applied: boolean; problems: string[] };
  /** B2 — see `LastUiWriteRef`'s own doc comment. Lazily created (and then reused in place) by `writeRuleEnabled`/`writeRuleFields` if the caller didn't supply one — but a caller that wants undo to work across SEPARATE calls (i.e. any real caller) must pass the SAME `RulesWriteDeps` object to every call, exactly as it already must for `env`/`io`. */
  lastUiWrite?: LastUiWriteRef;
  /**
   * STALE-FILE REFUSAL (agentsafety second pass, 2026-10-05): the
   * daemon's own currently-LOADED rules etag (`RulesHolder.getSourceEtag()`
   * — `src/daemon/index.ts` wires this to `() => rulesHolder.getSourceEtag()`).
   * Every write and every plan refuses while this differs from a FRESH
   * `rulesEtag()` read of the file on disk: the probed incident was an
   * admin hand-editing the file (disabling `managers`) without a reload,
   * then a UI write computing its plan/counts against the daemon's STALE
   * in-memory view — the plan said `stopped=0` for a rule the write was
   * about to make disappear from the next reload. Undefined (no holder to
   * compare against) skips the check — same "absent means disabled
   * check, never a false pass" discipline the rest of this slice follows;
   * every REAL caller supplies this.
   */
  getSourceEtag?: () => string | undefined;
}

/**
 * Throws `WriteRefusedError` (409) when the daemon's own loaded rules
 * (`deps.getSourceEtag()`) are not the SAME text `currentText` (the file's
 * own CURRENT content, as just read) was parsed from — see
 * `RulesWriteDeps.getSourceEtag`'s own doc comment. A `currentText` of
 * `undefined` (no file) hashes the same as the holder's own empty-rules
 * etag (`sha256("")`, `RulesHolder`'s own convention — see
 * `write-rules.ts`'s `rulesEtag`), so a fresh daemon with no file and no
 * rules loaded is never flagged stale against itself.
 */
function assertNotStale(deps: RulesWriteDeps, currentText: string | undefined): void {
  const sourceEtag = deps.getSourceEtag?.();
  if (sourceEtag === undefined) return;
  const fileEtag = sha256(currentText ?? "");
  if (sourceEtag !== fileEtag) {
    throw new WriteRefusedError(`rules file changed since the daemon loaded it (daemon is at ${sourceEtag}, file is at ${fileEtag}); reload first`, 409);
  }
}

export type RulesWriteOutcome =
  | { ok: true; backupId: string | null; etag: string; changedIds: string[]; reload: { applied: boolean; problems: string[] } }
  | { ok: false; status: number; error: string };

const defaultReload = (): { applied: boolean; problems: string[] } => ({ applied: true, problems: [] });

function readCurrentRulesText(env: RulesEnv): string | undefined {
  try {
    return readFileSync(rulesPath(env), "utf8");
  } catch {
    return undefined;
  }
}

function toOutcome(result: WriteRulesResult, deps: RulesWriteDeps): RulesWriteOutcome {
  return { ok: true, backupId: result.backupId, etag: result.etag, changedIds: result.changedIds, reload: (deps.reload ?? defaultReload)() };
}

function refusalToOutcome(e: unknown): RulesWriteOutcome {
  if (e instanceof WriteRefusedError) return { ok: false, status: e.status, error: e.message };
  if (e instanceof RuleWriteApplyError) return { ok: false, status: 400, error: e.message };
  const message = (e as Error)?.message ?? String(e);
  // `assertOnlyChanged`'s own throw shape (FACTORY-658) — a change outside
  // the allowlist. Always a forbidden-action refusal here, never a 400:
  // this slice's own validators (`validateRuleFieldPatch`) already reject
  // every shape that could produce this on their own, so reaching it means
  // either a non-`ui-` prefixed rule somehow got here, or a bug — either
  // way, "refused" is the correct and safe answer.
  if (message.includes("is not in the allowed set")) return { ok: false, status: 403, error: message };
  if (message.includes("etag mismatch") || message.includes("already being written")) return { ok: false, status: 409, error: message };
  // A crashed-writer's leftover `.rules.lock` (FACTORY-673's own message,
  // which already names the lock PATH and the exact `rm <path>` to run) —
  // passed through VERBATIM, never replaced with a generic one, so the UI
  // can show a human exactly what to remove. 503: this is "this daemon
  // cannot serve a write right now", not a problem with the request itself.
  if (message.includes(".rules.lock") || message.includes("was left behind by pid")) return { ok: false, status: 503, error: message };
  return { ok: false, status: 400, error: message };
}

function assertUiEditable(id: string): void {
  if (!isUiEditableRuleId(id)) {
    throw new WriteRefusedError(`rule "${id}" does not carry the "ui-" prefix — only web-UI-marked rules may be written by this route`, 403);
  }
}

function checkIfMatch(currentText: string | undefined, ifMatch: string): void {
  const currentEtag = sha256(currentText ?? "");
  if (ifMatch !== currentEtag) {
    throw new WriteRefusedError(`etag mismatch — expected ${ifMatch}, the rules file is currently at ${currentEtag}; reload and retry`, 409);
  }
}

/**
 * B3's own local (non-Jira) blast-radius counts: whether this edit, applied
 * to a rule currently in state `wasEnabled`, would spawn (newly enabled),
 * stop (newly disabled), or restart (stays enabled, but `query` or
 * `agentPreferences` changes) a running agent. Pure, synchronous, and the
 * SAME function both `planRuleWrite` (the report-only dry-run) and the
 * actual write functions call — so there is exactly one place this
 * decision is made, never two that could disagree.
 */
export function computeLocalPlanCounts(wasEnabled: boolean, patch: RuleFieldPatch): { spawned: number; stopped: number; restarted: number } {
  if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
    return patch.enabled ? { spawned: 1, stopped: 0, restarted: 0 } : { spawned: 0, stopped: 1, restarted: 0 };
  }
  const otherFieldsChanged = patch.query !== undefined || patch.agentPreferences !== undefined;
  return { spawned: 0, stopped: 0, restarted: wasEnabled && otherFieldsChanged ? 1 : 0 };
}

/** B3's own plan hash: binds the EXACT next document text to the counts computed for it — `planRuleWrite` and the real write functions both call this over the SAME `nextText` (built by `applyRuleFieldPatch`), so a plan computed against one file state can never be echoed successfully against a different one. */
export function buildPlanHash(nextText: string, counts: { spawned: number; stopped: number; restarted: number }): string {
  return sha256(JSON.stringify({ nextText, ...counts }));
}

function requireConfirmForBlastRadius(counts: { spawned: number; stopped: number; restarted: number }, confirm: boolean): void {
  if ((counts.stopped > 0 || counts.restarted > 0) && !confirm) {
    throw new WriteRefusedError(`this change would stop ${counts.stopped} and restart ${counts.restarted} running agent(s) — retry with confirm: true to proceed`, 409);
  }
}

function recordLastUiWrite(deps: RulesWriteDeps, backupId: string | null, resultingEtag: string): void {
  if (backupId === null) return; // no prior file existed — nothing to ever undo TO
  if (!deps.lastUiWrite) deps.lastUiWrite = { value: null };
  deps.lastUiWrite.value = { backupId, resultingEtag };
}

/**
 * `POST /api/rules/:id/enabled`'s own write. Refuses: a non-`ui-` id, a
 * stale `ifMatch`, enabling while `query` is still the placeholder, (when
 * enabling) a dry-run scope above `ENABLE_SCOPE_CEILING` without `confirm`,
 * a `planHash` that doesn't match the fresh locked recomputation (B3), and
 * disabling (`stopped=1`) without `confirm` (B3). `scopeOf` is the SAME
 * dry-run `rulesPreview`'s previewer already performs (`../web/rules-
 * preview.ts`) — never a second query mechanism. The scope/placeholder
 * check runs TWICE — once up front (outside the lock, so a doomed Jira
 * round trip is never attempted for a request that cannot possibly
 * succeed) and again inside the lock immediately before the write
 * (authoritative; a race in between can only cause an extra rejected
 * attempt, never an unsafe accepted one).
 */
export async function writeRuleEnabled(id: string, enabled: boolean, ifMatch: string, confirm: boolean, planHash: string, scopeOf: (id: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesWriteOutcome> {
  const env = deps.env ?? process.env;

  if (enabled) {
    let current: Record<string, unknown>;
    try {
      current = readRuleById(readCurrentRulesText(env), id);
    } catch (e) {
      if (e instanceof RuleWriteApplyError) return { ok: false, status: 400, error: e.message };
      throw e;
    }
    if (!isUiEditableRuleId(id)) return { ok: false, status: 403, error: `rule "${id}" does not carry the "ui-" prefix — only web-UI-marked rules may be written by this route` };
    if (current.query === PLACEHOLDER_QUERY) {
      return { ok: false, status: 403, error: `rule "${id}" cannot be enabled while its query is still the placeholder — edit the query first` };
    }
    const scope = await scopeOf(id);
    if (scope > ENABLE_SCOPE_CEILING && !confirm) {
      return { ok: false, status: 409, error: `enabling "${id}" would stage ${scope} ticket(s), above the ${ENABLE_SCOPE_CEILING}-ticket confirm ceiling — retry with confirm: true to proceed` };
    }
  }

  // Built fresh inside the mutator below (the LOCKED read) and read by
  // `commitWrite` via this getter AFTER the mutator returns — see this
  // module's own header and `buildEnabledAllowedPaths`'s doc comment
  // (`./rules-write-apply.ts`) for why a STATIC `"rules.*.enabled"` would
  // wrongly permit ANY rule's `enabled` to flip, not just this one
  // (agentsafety's 2026-10-05 17:0x PDT re-check finding).
  let allowedPaths: string[] = [];
  try {
    const result = updateRulesFile(
      (currentText) => {
        checkIfMatch(currentText, ifMatch);
        assertNotStale(deps, currentText);
        const rule = readRuleById(currentText, id);
        assertUiEditable(id);
        if (enabled && rule.query === PLACEHOLDER_QUERY) {
          throw new WriteRefusedError(`rule "${id}" cannot be enabled while its query is still the placeholder — edit the query first`, 403);
        }
        const nextText = applyRuleFieldPatch(currentText, id, { enabled });
        const counts = computeLocalPlanCounts(rule.enabled === true, { enabled });
        const freshHash = buildPlanHash(nextText, counts);
        if (freshHash !== planHash) {
          throw new WriteRefusedError(`planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again`, 409);
        }
        requireConfirmForBlastRadius(counts, confirm);
        allowedPaths = buildEnabledAllowedPaths(currentText, id);
        return nextText;
      },
      env,
      deps.io,
      { get allowedPaths() { return allowedPaths; } },
    );
    recordLastUiWrite(deps, result.backupId, result.etag);
    return toOutcome(result, deps);
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `PUT /api/rules/:id`'s own write — the nested allowlist (`query`,
 * `agentPreferences[i].model/effort/modelPower/effortPower`). Deliberately
 * does NOT accept `enabled`: toggling that has its own dedicated route
 * (`writeRuleEnabled` above) with its own scope-ceiling/placeholder gates,
 * which a PUT that also permitted `enabled` would silently bypass. Same
 * `planHash`/`confirm` binding as `writeRuleEnabled` (B3): editing
 * `query`/`agentPreferences` on an already-enabled rule restarts its agent
 * (`restarted=1`), which now requires `confirm: true` exactly like a stop.
 */
export function writeRuleFields(id: string, patch: RuleFieldPatch, ifMatch: string, confirm: boolean, planHash: string, deps: RulesWriteDeps): RulesWriteOutcome {
  if (patch.enabled !== undefined) {
    return { ok: false, status: 400, error: `PUT /api/rules/:id does not accept "enabled" — use POST /api/rules/:id/enabled` };
  }
  let allowedPaths: string[] = [];
  try {
    const result = updateRulesFile(
      (currentText) => {
        checkIfMatch(currentText, ifMatch);
        assertNotStale(deps, currentText);
        const rule = readRuleById(currentText, id); // throws if unknown
        assertUiEditable(id);
        const nextText = applyRuleFieldPatch(currentText, id, patch);
        const counts = computeLocalPlanCounts(rule.enabled === true, patch);
        const freshHash = buildPlanHash(nextText, counts);
        if (freshHash !== planHash) {
          throw new WriteRefusedError(`planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again`, 409);
        }
        requireConfirmForBlastRadius(counts, confirm);
        allowedPaths = buildFieldsAllowedPaths(currentText, id, patch);
        return nextText;
      },
      deps.env ?? process.env,
      deps.io,
      { get allowedPaths() { return allowedPaths; } },
    );
    recordLastUiWrite(deps, result.backupId, result.etag);
    return toOutcome(result, deps);
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `POST /api/undo/:backupId` (B2) — restores a backup through the SAME
 * validated/atomic/backed-up path every other write uses (`restoreBackup`,
 * FACTORY-658), but ONLY the backup this SAME process's most recent
 * successful UI write produced, and ONLY while the file is still at that
 * write's own resulting etag — see `LastUiWriteRef`'s own doc comment and
 * this module's header for why. Clears the tracked write on success: once
 * undone, there is nothing left to undo a second time.
 */
export function writeUndo(backupId: string, deps: RulesWriteDeps): RulesWriteOutcome {
  const last = deps.lastUiWrite?.value;
  if (!last || last.backupId !== backupId) {
    return { ok: false, status: 403, error: `undo is only permitted for the most recent web-UI write's own backup — "${backupId}" is not it (or no UI write has happened yet this process)` };
  }
  const currentEtag = rulesEtag(deps.env ?? process.env, deps.io);
  if (currentEtag !== last.resultingEtag) {
    return { ok: false, status: 409, error: `the rules file has changed since that write (expected etag ${last.resultingEtag}, found ${currentEtag}) — undo refused rather than reverting a change it did not make` };
  }
  try {
    const result = restoreBackup(backupId, deps.env ?? process.env, deps.io);
    if (deps.lastUiWrite) deps.lastUiWrite.value = null;
    return toOutcome(result, deps);
  } catch (e) {
    return refusalToOutcome(e);
  }
}

export interface RulesPlanResult {
  ok: true;
  planHash: string;
  spawned: number;
  stopped: number;
  restarted: number;
  scope: number | null;
  etag: string;
  requiresConfirm: boolean;
}
export type RulesPlanOutcome = RulesPlanResult | { ok: false; status: number; error: string };

/**
 * `POST /api/rules/plan` — REPORT ONLY, never writes anything (requirement
 * 5 of the director's "DECISION ADDED" comment). Builds the exact
 * `nextText` the real write would produce (`applyRuleFieldPatch`) and the
 * local blast-radius counts (`computeLocalPlanCounts`) — the SAME two
 * computations `writeRuleEnabled`/`writeRuleFields` redo under the lock —
 * so `planHash` (`buildPlanHash`) is a real commitment an apply call can
 * verify, not a separate guess. `scope` (Jira dry-run ticket count) is
 * fleet-blind by design, same as before: the daemon's real reconcile loop
 * (`src/daemon/loop.ts`) considers the whole fleet's admission state, which
 * this report-only dry-run deliberately does not re-run. A caller wanting
 * the fleet-wide admission picture should read `/api/rules/:id/preview`'s
 * own `warning` field too.
 */
export async function planRuleWrite(id: string, patch: RuleFieldPatch, confirm: boolean, scopeOf: (id: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesPlanOutcome> {
  const env = deps.env ?? process.env;
  const currentText = readCurrentRulesText(env);
  try {
    assertNotStale(deps, currentText);
  } catch (e) {
    if (e instanceof WriteRefusedError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  let current: Record<string, unknown>;
  let nextText: string;
  try {
    current = readRuleById(currentText, id);
    nextText = applyRuleFieldPatch(currentText, id, patch);
  } catch (e) {
    if (e instanceof RuleWriteApplyError) return { ok: false, status: 400, error: e.message };
    throw e;
  }
  if (!isUiEditableRuleId(id)) return { ok: false, status: 403, error: `rule "${id}" does not carry the "ui-" prefix` };

  const etag = rulesEtag(env, deps.io);
  const wasEnabled = current.enabled === true;

  if (patch.enabled === true && !wasEnabled && current.query === PLACEHOLDER_QUERY) {
    return { ok: false, status: 403, error: `rule "${id}" cannot be enabled while its query is still the placeholder` };
  }

  const counts = computeLocalPlanCounts(wasEnabled, patch);
  let scope: number | null = null;
  if (counts.spawned > 0) scope = await scopeOf(id);
  const requiresConfirm = (scope !== null && scope > ENABLE_SCOPE_CEILING && !confirm) || ((counts.stopped > 0 || counts.restarted > 0) && !confirm);

  const planHash = buildPlanHash(nextText, counts);
  return { ok: true, planHash, spawned: counts.spawned, stopped: counts.stopped, restarted: counts.restarted, scope, etag, requiresConfirm };
}
