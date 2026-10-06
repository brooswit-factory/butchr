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
 * query) throws from inside the mutator, which `updateRulesFile` propagates
 * with NOTHING written — same "throws, writes nothing" contract
 * `writeRulesFile` itself documents for a doomed call.
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

export interface RulesWriteDeps {
  env?: RulesEnv;
  io?: WriteRulesIo;
  /**
   * FACTORY-657's reload, behind an interface per this ticket's own "stub
   * it behind an interface, wire when 657's PR is up" instruction — 657 is
   * not yet on `main`. The default stub below reports "applied" without
   * actually hot-swapping this already-running daemon's in-memory `rules` —
   * that swap is 657's own job. Documented here, not hidden: this daemon's
   * live agent set does not actually change from a web write until a
   * restart until 657 lands and this is wired to it.
   */
  reload?: (etag: string) => { applied: boolean; problems: string[] };
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
  return { ok: true, backupId: result.backupId, etag: result.etag, changedIds: result.changedIds, reload: (deps.reload ?? defaultReload)(result.etag) };
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
 * `POST /api/rules/:id/enabled`'s own write. Refuses: a non-`ui-` id, a
 * stale `ifMatch`, enabling while `query` is still the placeholder, and
 * (when enabling) a dry-run scope above `ENABLE_SCOPE_CEILING` without
 * `confirm`. `scopeOf` is the SAME dry-run `rulesPreview`'s previewer
 * already performs (`../web/rules-preview.ts`) — never a second query
 * mechanism. The scope/placeholder check runs TWICE — once up front
 * (outside the lock, so a doomed Jira round trip is never attempted for a
 * request that cannot possibly succeed) and again inside the lock
 * immediately before the write (authoritative; a race in between can only
 * cause an extra rejected attempt, never an unsafe accepted one).
 */
export async function writeRuleEnabled(id: string, enabled: boolean, ifMatch: string, confirm: boolean, scopeOf: (id: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesWriteOutcome> {
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
        const rule = readRuleById(currentText, id);
        assertUiEditable(id);
        if (enabled && rule.query === PLACEHOLDER_QUERY) {
          throw new WriteRefusedError(`rule "${id}" cannot be enabled while its query is still the placeholder — edit the query first`, 403);
        }
        allowedPaths = buildEnabledAllowedPaths(currentText, id);
        return applyRuleFieldPatch(currentText, id, { enabled });
      },
      env,
      deps.io,
      { get allowedPaths() { return allowedPaths; } },
    );
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
 * which a PUT that also permitted `enabled` would silently bypass.
 */
export function writeRuleFields(id: string, patch: RuleFieldPatch, ifMatch: string, deps: RulesWriteDeps): RulesWriteOutcome {
  if (patch.enabled !== undefined) {
    return { ok: false, status: 400, error: `PUT /api/rules/:id does not accept "enabled" — use POST /api/rules/:id/enabled` };
  }
  let allowedPaths: string[] = [];
  try {
    const result = updateRulesFile(
      (currentText) => {
        checkIfMatch(currentText, ifMatch);
        readRuleById(currentText, id); // throws if unknown
        assertUiEditable(id);
        allowedPaths = buildFieldsAllowedPaths(currentText, id, patch);
        return applyRuleFieldPatch(currentText, id, patch);
      },
      deps.env ?? process.env,
      deps.io,
      { get allowedPaths() { return allowedPaths; } },
    );
    return toOutcome(result, deps);
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/** `POST /api/undo/:backupId` — restores a previous backup through the SAME validated/atomic/backed-up path every other write uses (`restoreBackup`, FACTORY-658) — never a second restore mechanism. */
export function writeUndo(backupId: string, deps: RulesWriteDeps): RulesWriteOutcome {
  try {
    const result = restoreBackup(backupId, deps.env ?? process.env, deps.io);
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
 * 5 of the director's "DECISION ADDED" comment). A heuristic, not a full
 * reconcile simulation: the daemon's real reconcile loop
 * (`src/daemon/loop.ts`) considers the whole fleet's admission state, which
 * this endpoint deliberately does not re-run (that would mean this
 * report-only dry-run doing the SAME expensive work the next real poll
 * already does). What it reports instead: for an `enabled` flip, 1 agent
 * spawned/stopped (this rule's own `execution: "singleton"` template has
 * exactly one query-level agent) plus the dry-run ticket SCOPE (the same
 * count `rulesPreview` computes); for any other field edit on an already-
 * enabled rule, 1 restart (a running query-agent restarts on its next poll
 * when its own preferences/query change) and no spawn/stop. Stated plainly
 * rather than hidden: a caller wanting the fleet-wide admission picture
 * should read `/api/rules/:id/preview`'s own `warning` field too.
 */
export async function planRuleWrite(id: string, patch: RuleFieldPatch, confirm: boolean, scopeOf: (id: string) => Promise<number>, deps: RulesWriteDeps): Promise<RulesPlanOutcome> {
  const env = deps.env ?? process.env;
  let current: Record<string, unknown>;
  try {
    current = readRuleById(readCurrentRulesText(env), id);
  } catch (e) {
    if (e instanceof RuleWriteApplyError) return { ok: false, status: 400, error: e.message };
    throw e;
  }
  if (!isUiEditableRuleId(id)) return { ok: false, status: 403, error: `rule "${id}" does not carry the "ui-" prefix` };

  const etag = rulesEtag(env, deps.io);
  const wasEnabled = current.enabled === true;
  let spawned = 0, stopped = 0, restarted = 0, scope: number | null = null, requiresConfirm = false;

  if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
    if (patch.enabled) {
      if (current.query === PLACEHOLDER_QUERY) return { ok: false, status: 403, error: `rule "${id}" cannot be enabled while its query is still the placeholder` };
      scope = await scopeOf(id);
      spawned = 1;
      requiresConfirm = scope > ENABLE_SCOPE_CEILING && !confirm;
    } else {
      stopped = 1;
    }
  } else if (wasEnabled && (patch.query !== undefined || patch.agentPreferences !== undefined)) {
    restarted = 1;
  }

  const planHash = sha256(JSON.stringify({ id, patch, etag }));
  return { ok: true, planHash, spawned, stopped, restarted, scope, etag, requiresConfirm };
}
