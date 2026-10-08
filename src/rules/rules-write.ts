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
import { isUiEditableRuleId, PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING, RISKY_PERMISSION_MODES, type RuleFieldPatch } from "./rules-write-registry.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * FACTORY-687 — `current` here is the RAW object out of `readRuleById`
 * (`parseRulesDoc`'s own shape), not the `loadRules`-normalized rule, and
 * `rules.ts` normalizes a missing `execution` to `"swarm"`. Comparing
 * `current.execution === "swarm"` directly therefore misses a rule that
 * simply omits the field — a swarm rule at runtime that neither gate below
 * would catch. This mirrors that same default inline wherever the raw value
 * is compared.
 */
const executionOf = (raw: unknown): string => (raw === undefined ? "swarm" : String(raw));

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
  // FACTORY-729: permissionMode/lizardMode change the SpawnSpec an
  // already-running rule's agent was launched with, same as query/
  // agentPreferences — counted as a restart for the SAME reason those are.
  const otherFieldsChanged = patch.query !== undefined || patch.agentPreferences !== undefined || patch.permissionMode !== undefined || patch.lizardMode !== undefined;
  return { spawned: 0, stopped: 0, restarted: wasEnabled && otherFieldsChanged ? 1 : 0 };
}

/**
 * Review round 1 (PR #651) finding 1 — `JSON.stringify` turns
 * `Number.POSITIVE_INFINITY`/`NaN` into `null`, which is EXACTLY the wire
 * value `scope: null` already means for "no previewer call was ever made
 * for this patch" (`counts.spawned === 0`). Hashing the raw `scope` number
 * directly would make an UNMEASURABLE scope (previewer genuinely
 * unavailable) hash identically to a NOT-EVALUATED scope — a plan/apply
 * pair that both see a down previewer would then produce a planHash that
 * matches a hash built with `scope: null` for an entirely different
 * (spawn-free) patch, and — worse — would let `confirm: true` sail through
 * `writeRuleEnabled`'s hash check with a scope that was never actually
 * measured. Tagging the unmeasurable case as the STRING `"unmeasurable"`
 * (never a bare number, never `null`) makes it hash differently from both
 * a real finite scope and a true "not evaluated" `null` — see
 * `writeRuleEnabled`'s own hard fail-closed check just below for the other
 * half of this fix (it refuses an unmeasurable scope outright, before the
 * hash is even built, so this tagging is defense in depth, not the only
 * guard).
 */
function scopeHashValue(scope: number | null): string | number | null {
  if (scope === null) return null;
  return Number.isFinite(scope) ? scope : "unmeasurable";
}

/**
 * B3's own plan hash: binds the EXACT next document text to the counts
 * computed for it, AND (N1, FACTORY-678) the evaluated `scope` — `null`
 * whenever `counts.spawned === 0` (no previewer call was ever made for
 * this patch, same as `planRuleWrite`'s own gate), otherwise the real
 * ticket count the previewer reported (or the `"unmeasurable"` tag — see
 * `scopeHashValue` above — when the previewer genuinely failed). `planRuleWrite`
 * and the real write functions both call this over the SAME `nextText`
 * (built by `applyRuleFieldPatch`) and the SAME scope value, so a plan
 * computed against one file state (or one scope reading) can never be
 * echoed successfully against a different one — in particular, `confirm:
 * true` can no longer land a write whose scope was never bound into this
 * hash.
 */
export function buildPlanHash(nextText: string, counts: { spawned: number; stopped: number; restarted: number }, scope: number | null): string {
  return sha256(JSON.stringify({ nextText, ...counts, scope: scopeHashValue(scope) }));
}

/**
 * N1 (FACTORY-678) — a short-lived cache sitting between the write path's
 * own `scopeOf` and the real previewer (`../web/rules-preview.ts`):
 * `planRuleWrite` and `writeRuleEnabled` each call `scopeOf` once for the
 * same rule id, typically seconds apart (a UI's plan-then-apply flow), and
 * the previewer itself refuses a second real call on the same rule within
 * its own `DEFAULT_PREVIEW_RATE_LIMIT_MS` (2s) window. Without this cache,
 * that refusal fails SAFE to `Number.POSITIVE_INFINITY` (see `scopeOf`'s
 * own wiring in `../daemon/index.ts`), which trips the scope ceiling on
 * every back-to-back apply — see FACTORY-677/678 for the full diagnosis.
 *
 * `ttlMs` (default 10s) is deliberately longer than the previewer's own
 * 2s rate limit, so a plan followed by an apply well within a normal UI
 * interaction always reuses the SAME measured scope rather than racing
 * the previewer's own window. `now`/`ttlMs` are injectable so a test needs
 * no real timers. One instance must be shared across every call for a
 * given rule id to actually elide a second previewer call — `../daemon/
 * index.ts` wires ONE shared instance around its own `scopeOf`, exactly
 * like `rulesPreviewer` itself is one shared instance for the same reason.
 */
export interface ScopeCacheDeps {
  ttlMs?: number;
  now?: () => number;
}

/** `createScopeCache`'s own return type: callable exactly like the old bare function (`scopeOf(id, queryText)`), plus `clear()` — see that function's own doc comment for why both exist. */
export interface ScopeOf {
  (id: string, queryText: string): Promise<number>;
  /** FACTORY-685 (N4): drops every cached entry — wired at every reload/write call site in `src/daemon/index.ts` so a stale scope reading can never outlive the write (or SIGHUP) that invalidated it. */
  clear(): void;
}

/**
 * FACTORY-685 (N4, agentsafety audit #50): the N1 cache above was keyed by
 * rule id ALONE — a plan on a 3-ticket query, then a widened-to-40-tickets
 * query planned again within the same 10s TTL, still answered "3", because
 * the query text never reached the cache key at all. Keyed by `id` PLUS a
 * hash of the CURRENT query text instead: a changed query is a changed key,
 * so it can never reuse a stale entry regardless of the TTL. `queryText` is
 * supplied by the caller (`planRuleWrite`/`writeRuleEnabled`, which already
 * `readRuleById` before calling this) — `scopeOf` itself (the real
 * previewer) still takes only `id`, since the previewer re-reads the rule's
 * CURRENT query from the live file itself; the query text here exists
 * purely to key the cache, never passed through to `scopeOf`.
 *
 * `clear()` (new) drops every entry — belt-and-suspenders alongside the
 * query-hash keying: `src/daemon/index.ts` calls it from every reload path
 * (a web write's own reload, SIGHUP, the `reloadRulesNow` HTTP route), so a
 * cached reading can never survive whatever caused the reload, even for a
 * rule whose query text happens not to have changed (e.g. the underlying
 * Jira data shifted instead).
 */
export function createScopeCache(scopeOf: (id: string) => Promise<number>, deps: ScopeCacheDeps = {}): ScopeOf {
  const ttlMs = deps.ttlMs ?? 10_000;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { scope: number; at: number }>();
  const cachedScopeOf = (async (id: string, queryText: string): Promise<number> => {
    const key = `${id}:${sha256(queryText)}`;
    const t = now();
    const cached = cache.get(key);
    if (cached !== undefined && t - cached.at < ttlMs) return cached.scope;
    const scope = await scopeOf(id);
    cache.set(key, { scope, at: t });
    return scope;
  }) as ScopeOf;
  cachedScopeOf.clear = () => cache.clear();
  return cachedScopeOf;
}

function requireConfirmForBlastRadius(counts: { spawned: number; stopped: number; restarted: number }, confirm: boolean): void {
  if ((counts.stopped > 0 || counts.restarted > 0) && !confirm) {
    throw new WriteRefusedError(`this change would stop ${counts.stopped} and restart ${counts.restarted} running agent(s) — retry with confirm: true to proceed`, 409);
  }
}

/**
 * FACTORY-729: `permissionMode: "bypassPermissions" | "auto"` and
 * `lizardMode: true` are never defaults (`RuleFieldPatch`'s own doc
 * comments, `./rules-write-registry.ts`) — a write that SETS either one
 * must say so explicitly via `confirm: true`, independent of, and checked
 * in addition to, `requireConfirmForBlastRadius` above (a patch can trip
 * both gates at once; either missing confirmation refuses the whole
 * write). Mirrors that function's own shape: a pure, synchronous check
 * `rawRiskyField`/`planRuleWrite` and `writeRuleFields` both reduce to, so
 * the plan and the apply can never disagree about whether this gate
 * applies to a given patch.
 *
 * FACTORY-817: `role: "sentinel"` joins this gate — deliberately, not an
 * oversight. Unlike `permissionMode`/`lizardMode` (which change what an
 * agent is allowed to do unattended), `"sentinel"` changes whether a rule's
 * agent(s) are even subject to `BUTCHR_MAX_AGENTS` at all — an operator
 * silently opting a rule out of the fleet cap is exactly the kind of
 * "slipped in alongside an unrelated edit" change this gate exists to
 * catch. `"worker"` (the default, ON) requires no confirm, same as every
 * other safe default on this gate.
 */
function isRiskyFieldPatch(patch: Pick<RuleFieldPatch, "permissionMode" | "lizardMode" | "role">): boolean {
  return (patch.permissionMode !== undefined && RISKY_PERMISSION_MODES.has(patch.permissionMode)) || patch.lizardMode === true || patch.role === "sentinel";
}

function requireConfirmForRiskyFields(patch: Pick<RuleFieldPatch, "permissionMode" | "lizardMode" | "role">, confirm: boolean): void {
  if (isRiskyFieldPatch(patch) && !confirm) {
    const named = [
      patch.permissionMode !== undefined && RISKY_PERMISSION_MODES.has(patch.permissionMode) ? `permissionMode: ${JSON.stringify(patch.permissionMode)}` : undefined,
      patch.lizardMode === true ? "lizardMode: true" : undefined,
      patch.role === "sentinel" ? `role: "sentinel"` : undefined,
    ].filter((s): s is string => s !== undefined);
    throw new WriteRefusedError(`setting ${named.join(" and ")} is never a default and requires an explicit confirm — retry with confirm: true to proceed`, 409);
  }
}

/**
 * A human-readable stand-in for a non-finite scope (the previewer failed
 * fail-safe to `Number.POSITIVE_INFINITY` — see `scopeOf`'s own wiring in
 * `../daemon/index.ts`) — `Infinity`/`NaN` must never appear as a literal
 * in an error string (they both survive `String()`/template interpolation,
 * even though `JSON.stringify` itself would turn them into `null`).
 */
function scopeLabel(scope: number): string {
  return Number.isFinite(scope) ? `${scope}` : "an unknown number of (the previewer could not measure it)";
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
 *
 * FACTORY-685 (item 2, agentsafety F1): a swarm rule's enable is ALSO
 * refused (409) without `confirm: true`, independent of the ceiling — one
 * agent per matching ticket is a real staffing decision at ANY scope, not
 * only above `ENABLE_SCOPE_CEILING`. Checked only after `scopeForHash` is
 * confirmed finite (the unmeasurable-scope guard above stays the first and
 * unconditional gate — there is no real number to name in this gate's own
 * message otherwise).
 */
export async function writeRuleEnabled(id: string, enabled: boolean, ifMatch: string, confirm: boolean, planHash: string, scopeOf: (id: string, queryText: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesWriteOutcome> {
  const env = deps.env ?? process.env;

  // N1 (FACTORY-678): computed OUTSIDE the lock (the mutator passed to
  // `updateRulesFile` is synchronous, so `scopeOf` — a real Jira call, or
  // (via `createScopeCache`) a cache lookup standing in for one — can never
  // run inside it). Only evaluated when this call is an actual SPAWN (the
  // rule is not already enabled) — the SAME gate `planRuleWrite`'s own
  // `counts.spawned > 0` check uses — so the value bound into the hash
  // below agrees with the value a preceding `planRuleWrite` call for the
  // SAME patch would have computed. `confirm: true` only skips the ceiling
  // THROW immediately below; it never skips this evaluation or the hash
  // binding under the lock, so a confirmed write still cannot land with a
  // scope that was never measured.
  let scopeForHash: number | null = null;
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
    if (current.enabled !== true) {
      scopeForHash = await scopeOf(id, String(current.query ?? ""));
      // Review round 1 (PR #651) finding 1 — this check must NOT be
      // gated on `!confirm` like the ceiling check below: the ceiling
      // check's whole premise is "the human saw a real number and
      // confirmed THAT number"; an unmeasurable scope means no real
      // number was ever seen, so there is nothing a `confirm: true` could
      // possibly be confirming. Fails closed UNCONDITIONALLY — this is
      // the "genuinely unavailable previewer still fails closed" guarantee
      // extended to hold even when the caller passes `confirm: true`.
      if (!Number.isFinite(scopeForHash)) {
        return { ok: false, status: 503, error: `could not evaluate the scope for "${id}" — the previewer is unavailable; this write is refused closed (even with confirm: true) until scope can be measured — try again` };
      }
      // FACTORY-685 (item 2): ANY enable of a swarm rule needs an explicit
      // confirm — independent of, and checked before, the ceiling below.
      if (executionOf(current.execution) === "swarm" && !confirm) {
        return { ok: false, status: 409, error: `enabling "${id}" will staff up to ${scopeLabel(scopeForHash)} ticket(s); resend with confirm: true to proceed` };
      }
      if (scopeForHash > ENABLE_SCOPE_CEILING && !confirm) {
        return { ok: false, status: 409, error: `enabling "${id}" would stage ${scopeLabel(scopeForHash)} ticket(s), above the ${ENABLE_SCOPE_CEILING}-ticket confirm ceiling — retry with confirm: true to proceed` };
      }
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
        // N1 (FACTORY-678): bind the SAME scope value the pre-lock check
        // above evaluated into the hash — but only when this fresh, LOCKED
        // recomputation agrees it's a spawn (`counts.spawned > 0`, the same
        // gate `planRuleWrite` uses). A race that changed whether this is a
        // spawn between the pre-lock read and here produces a hash that
        // cannot match a legitimately-issued `planHash`, which is refused
        // below exactly like any other stale plan (B3) — never a write
        // whose scope silently goes unverified.
        const scope = counts.spawned > 0 ? scopeForHash : null;
        const freshHash = buildPlanHash(nextText, counts, scope);
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
        // `patch.enabled` is always undefined here (guarded above), so
        // `counts.spawned` is always 0 and no scope was ever evaluated for
        // this patch (same as `planRuleWrite`'s own gate) — `null`, always.
        const freshHash = buildPlanHash(nextText, counts, null);
        if (freshHash !== planHash) {
          throw new WriteRefusedError(`planHash does not match a fresh plan for this write (the file may have changed, or the plan is stale) — call POST /api/rules/plan again`, 409);
        }
        requireConfirmForBlastRadius(counts, confirm);
        requireConfirmForRiskyFields(patch, confirm);
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
  /**
   * Review round 1 (PR #651) finding 1 — `scope: null` already means "no
   * previewer call was ever made for this patch" (`spawned === 0`).
   * Without this field, a previewer that genuinely failed (Jira down,
   * timeout) ALSO serializes as `scope: null` (`JSON.stringify` turns
   * `Number.POSITIVE_INFINITY`/`NaN` into `null`), making the two cases
   * indistinguishable on the wire. `true` only when a spawn WAS evaluated
   * (`spawned > 0`) but the previewer could not produce a finite reading
   * — in that case `scope` is still `null` (never a fake number) and
   * `requiresConfirm` is always `true`. Absent/`false`/omitted in every
   * other case — a NEW, OPTIONAL field, so an existing reader (e.g. PR
   * #650) that doesn't know about it sees unchanged behavior.
   */
  scopeUnmeasurable?: boolean;
  etag: string;
  requiresConfirm: boolean;
  /**
   * FACTORY-685 (item 2): which gate is why `requiresConfirm` is `true` on
   * THIS call — a display discriminator for the dashboard's confirm
   * dialog. Present if and only if `requiresConfirm` is `true`: a call that
   * already passed `confirm: true` sees `requiresConfirm: false` and no
   * `confirmReason`, even if some gate would otherwise have applied —
   * there is nothing left to name a reason FOR. Priority when more than one
   * condition applies, most-specific first: `"unmeasurable-scope"` (no real
   * number exists to confirm — always wins), `"scope-ceiling"` (a real,
   * over-25 number — more informative than the generic swarm-enable
   * reason), `"swarm-enable"` (any other swarm enable), `"stop-restart"`,
   * `"risky-permission"` (FACTORY-729 — `permissionMode: "bypassPermissions"
   * | "auto"` or `lizardMode: true`), `"capacity-sentinel"` (FACTORY-817 —
   * `role: "sentinel"`; least specific of all, so a patch that ALSO trips
   * `stop-restart` or `risky-permission` reports that instead, which
   * already implies this one's own "confirm before this lands" posture).
   *
   * DELIBERATE DEVIATION from the ticket's literal `confirmRequired` +
   * `reason` field names (stated here and in the PR body per this ticket's
   * own instruction): `requiresConfirm` already ships and the dashboard
   * already reads it — renaming it is a breaking change to a live client
   * for no behavioral gain, so this field is additive instead.
   */
  confirmReason?: "unmeasurable-scope" | "scope-ceiling" | "swarm-enable" | "stop-restart" | "risky-permission" | "capacity-sentinel";
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
export async function planRuleWrite(id: string, patch: RuleFieldPatch, confirm: boolean, scopeOf: (id: string, queryText: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesPlanOutcome> {
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
  let scopeUnmeasurable = false;
  if (counts.spawned > 0) {
    const rawScope = await scopeOf(id, String(current.query ?? ""));
    if (Number.isFinite(rawScope)) {
      scope = rawScope;
    } else {
      // Review round 1 (PR #651) finding 1 — never let an unmeasurable
      // (Infinity/NaN) scope reach `scope` itself (it would serialize to
      // `null` and be indistinguishable from "not evaluated"); report it
      // through the dedicated `scopeUnmeasurable` flag instead, and force
      // `requiresConfirm` below regardless of `confirm` — there is no
      // real number for a caller to have confirmed.
      scopeUnmeasurable = true;
    }
  }
  // FACTORY-685 (item 2): ANY enable of a swarm rule needs confirm, not
  // only one above the ceiling — computed "raw" (independent of `confirm`)
  // so `confirmReason` can classify the gate even on a call that already
  // supplied `confirm: true`.
  const rawSwarmEnable = counts.spawned > 0 && executionOf(current.execution) === "swarm";
  const rawOverCeiling = scope !== null && scope > ENABLE_SCOPE_CEILING;
  const rawStopRestart = counts.stopped > 0 || counts.restarted > 0;
  // FACTORY-729: see `requireConfirmForRiskyFields`'s own doc comment — the
  // same raw/unconditional computation style as the three gates above, so
  // `confirmReason` can classify it even on a call that already supplied
  // `confirm: true`. FACTORY-817: split into its two named sub-reasons —
  // `rawRiskyField` (the UNION, for `requiresConfirm`) still fires on
  // either, but `confirmReason` below needs to know WHICH one to report.
  const rawRiskyPermission = (patch.permissionMode !== undefined && RISKY_PERMISSION_MODES.has(patch.permissionMode)) || patch.lizardMode === true;
  const rawCapacitySentinel = patch.role === "sentinel";
  const rawRiskyField = rawRiskyPermission || rawCapacitySentinel;
  const requiresConfirm = scopeUnmeasurable || (rawOverCeiling && !confirm) || (rawSwarmEnable && !confirm) || (rawStopRestart && !confirm) || (rawRiskyField && !confirm);
  // `confirmReason` names which gate is why `requiresConfirm` is `true` —
  // absent exactly when `requiresConfirm` is `false` (whether because no
  // gate applies at all, or because `confirm: true` already satisfies every
  // gate that WOULD otherwise apply), never a reason for a gate that isn't
  // actually requiring anything on THIS call.
  const confirmReason: RulesPlanResult["confirmReason"] = !requiresConfirm
    ? undefined
    : scopeUnmeasurable
      ? "unmeasurable-scope"
      : rawOverCeiling
        ? "scope-ceiling"
        : rawSwarmEnable
          ? "swarm-enable"
          : rawStopRestart
            ? "stop-restart"
            : rawRiskyPermission
              ? "risky-permission"
              : "capacity-sentinel";

  const planHash = buildPlanHash(nextText, counts, scopeUnmeasurable ? Number.POSITIVE_INFINITY : scope);
  return {
    ok: true,
    planHash,
    spawned: counts.spawned,
    stopped: counts.stopped,
    restarted: counts.restarted,
    scope,
    ...(scopeUnmeasurable ? { scopeUnmeasurable: true } : {}),
    etag,
    requiresConfirm,
    ...(confirmReason ? { confirmReason } : {}),
  };
}
