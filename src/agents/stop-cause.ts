import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceDirsForResource } from "./workspace.js";
import { EXEMPT_LABEL } from "./parked.js";

/**
 * FACTORY-849/FACTORY-852 — the durable half of "why did this workspace's
 * agent stop". `workspaceSessionId`/`persistDiscoveredSessionId`/
 * `invalidatePersistedSessionId` (src/agents/workspace.ts, FACTORY-314) are
 * the model this is built on: a small JSON file living next to this
 * workspace's own `.butchr-session-id.json`, a write half, and a read half
 * that fails safe to `undefined` on ENOENT. DELIBERATELY NOT the in-memory
 * stand-down registry (src/agents/stand-down.ts, BUTCHR-307) — that
 * registry is scoped to answer "is this id asleep right now", is reset by
 * any daemon restart, and its own top comment says that reset is SAFE for
 * its purpose (every active issue is simply desired again). A daemon
 * restart is exactly one of the events a respawned worker's "was my last
 * stop intentional" question has to survive, so this needs its own,
 * separately-persisted record rather than reading that registry's memory.
 */

/** The verbs/events this story found that butchr itself uses to end an agent's work on a ticket — see each call site (src/tools/defs.ts's `stand_down` handler; `finishWorker`/`shelveWorker`/`submitToBoss`/`finishWithoutABoss` in src/tools/relationship.ts) for why each one qualifies. */
export type StopReason = "stand_down" | "submit_to_boss" | "finish_without_a_boss" | "finish_worker" | "shelve_worker";

/** One workspace's recorded stop cause — `undefined` (never this type) means "nothing recorded", the same fail-safe shape `workspaceSessionId` already uses. */
export interface StopCauseRecord {
  reason: StopReason;
  /** `Date.now()`-comparable epoch ms of the write — carried for diagnostics only; the classifier below does not consult it. */
  at: number;
}

/** This workspace's own persisted stop-cause record (`.butchr-stop-cause.json`), or `undefined` for a workspace with none recorded yet, or whose record was cleared — see `clearStopCause`. Never throws: an ENOENT (no record) and a corrupt/partial file (a `SyntaxError` from `JSON.parse` — e.g. a write torn by a crash mid-`writeFileSync`) are BOTH indistinguishable from "nothing recorded" to this call's caller — the brief's fail-safe-to-`undefined` requirement covers more than the missing-file case `workspaceSessionId`/`workspaceModel`/`workspaceEffort` guard against, because this file, unlike theirs, is read on the "was my last stop intentional" path where a wrongly-thrown exception is worse than a wrongly-unintended verdict (see `classifyStop`'s own doc comment for why unintended is the cheap direction to be wrong in). Any OTHER read failure (e.g. EACCES) still throws — not a shape this story's fail-safe contract was asked to cover. */
export function workspaceStopCause(dir: string): StopCauseRecord | undefined {
  let raw: string;
  try { raw = readFileSync(join(dir, ".butchr-stop-cause.json"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  try { return JSON.parse(raw); }
  catch (e) { if (e instanceof SyntaxError) return undefined; throw e; }
}

/** Persists `reason` as this workspace's stop cause — the write half of `workspaceStopCause`. A REPLACE, not an append: a later call (a later intentional stop) simply overwrites the previous record, which is one half of this story's "clear/supersede" requirement — see `clearStopCause`'s own doc comment for the other half. Writes to a sibling temp file and renames over the target (same-directory `rename` is atomic on POSIX) rather than writing the target in place, so a reader can never observe the half-written state a plain `writeFileSync` would otherwise expose — the exact corruption shape `workspaceStopCause`'s own fail-safe parse guard above exists to tolerate if it ever happens anyway (a concurrent write from another process, say). */
export function persistIntentionalStop(dir: string, reason: StopReason, at: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  const record: StopCauseRecord = { reason, at };
  const target = join(dir, ".butchr-stop-cause.json");
  const tmp = join(dir, `.butchr-stop-cause.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, target);
}

/**
 * Removes this workspace's persisted stop-cause record — the explicit half
 * of superseding a stale marker, mirrored on `invalidatePersistedSessionId`
 * (src/agents/workspace.ts): tolerates ENOENT (nothing to remove is not an
 * error), never throws otherwise being out of scope for this best-effort
 * bookkeeping.
 *
 * WHERE THIS IS CALLED, AND WHY THAT IS THE RIGHT MOMENT (decided for DoD
 * item 4): `startWorker`/`adoptWorker(..., "start")` (src/tools/relationship.ts)
 * call this on the worker they are reactivating, in the SAME place and for
 * the SAME reason they already clear `EXEMPT_LABEL` (`butchr:shelved`,
 * BUTCHR-50) — that label means "currently shelved", a STATE, not a
 * history, and the verb that reverses the state is the verb that withdraws
 * the declaration; a stop-cause record is the same shape of claim ("this
 * workspace's last stop was intentional"), about to become false the
 * moment its boss sends it back to work (reactivating a shelved worker, or
 * sending an In Review worker back for another round — `startWorker`'s own
 * doc comment names both). Without this, a worker that called
 * `shelve_worker` or `submit_to_boss` on itself, got reactivated, and later
 * crashed for real would still read back its OLD "intentional" marker and
 * misclassify the NEW, genuinely unintended stop.
 *
 * NOT called from `stand_down`'s own wake path: that wake is the in-memory
 * registry this module deliberately does not depend on (see this file's
 * top comment), and nothing in THIS story's scope reaches the spawn path
 * where a resumed session would otherwise clear its own prior marker (the
 * scope guard explicitly forbids wiring this story into spawn/respawn).
 * That is a NAMED, not a silently accepted, gap: a ticket that calls
 * `stand_down` and is later respawned with no intervening `start_worker`
 * (or a later intentional stop of its own, which equally supersedes the
 * old record by the plain overwrite semantics above) keeps reading
 * "intentional" until one of those happens. Closing it is FACTORY-850's
 * job — it wires stop-cause into the spawn path and is the one place that
 * can tell "a resume is actually happening" apart from every other reason
 * this workspace's files might be touched.
 */
export function clearStopCause(dir: string): void {
  try { rmSync(join(dir, ".butchr-stop-cause.json")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

/**
 * Best-effort fan-out of `persistIntentionalStop` across every on-disk
 * workspace for `resourceId` — a resource can have one rule-engine
 * workspace per rule that matched it (`workspaceDirsForResource`,
 * src/agents/workspace.ts), the same reason `rewriteWorkspaceBriefSummary`
 * (src/tools/relationship.ts, BUTCHR-169) fans out a write the same way.
 * NEVER THROWS: by the time any of this story's five write sites call this,
 * the real Jira write it is recording has already succeeded (or, for
 * `stand_down`, the sleep snapshot already landed) and must not be undone
 * by a filesystem problem. No workspace on disk for `resourceId` (an agent
 * never spawned, or already cleaned up) is the common, expected case, not
 * an error — silently a no-op, same as `rewriteWorkspaceBriefSummary`'s own
 * "no-workspace-on-disk" outcome.
 */
export function recordIntentionalStop(resourceId: string, reason: StopReason, root?: string): void {
  let dirs: string[];
  try { dirs = workspaceDirsForResource("jira-work", resourceId, root); } catch { return; }
  for (const dir of dirs) {
    try { persistIntentionalStop(dir, reason); } catch { /* best-effort — see this function's own doc comment */ }
  }
}

/** The `clearStopCause` counterpart to `recordIntentionalStop` — same fan-out, same never-throws discipline, called from `startWorker`/`adoptWorker(..., "start")`. */
export function clearIntentionalStop(resourceId: string, root?: string): void {
  let dirs: string[];
  try { dirs = workspaceDirsForResource("jira-work", resourceId, root); } catch { return; }
  for (const dir of dirs) {
    try { clearStopCause(dir); } catch { /* best-effort — see recordIntentionalStop's own doc comment */ }
  }
}

export type StopClassification = "intentional" | "unintended";

/**
 * The read-time rule (DoD item 3): PURE and total over one already-fetched
 * snapshot — a recorded stop-cause record, the ticket's current status, and
 * its current labels — exactly the three inputs FACTORY-849/FACTORY-843
 * specify, costing no Jira or filesystem call of its own (both reads are
 * the caller's job: `workspaceStopCause` for the first input, the ticket's
 * own `jira_get_issue`-shaped fields for the other two).
 *
 * `intentional` when ANY of:
 *  - a stop-cause record is present at all (its specific `reason` is never
 *    consulted here — every reason this story records is, by construction,
 *    a butchr-caused end of work; see `StopReason`'s own doc comment for
 *    the full list).
 *  - `ticketStatus` is `"Done"` — this codebase's own sole terminal-status
 *    literal (see e.g. `openWorkers`/`assertOwnWorker` in
 *    src/tools/relationship.ts, which already compare against `"Done"`
 *    alone to mean closed; there is no second "Closed" synonym anywhere in
 *    this codebase to also check).
 *  - `ticketLabels` carries `EXEMPT_LABEL` (`butchr:shelved`,
 *    src/agents/parked.ts) — the shelved-exemption literal, imported, never
 *    retyped.
 *
 * Everything else — including a workspace this classifier cannot find a
 * stop-cause record for at all (a pane that simply vanished, a missing
 * record file, a workspace from before this ticket) — is `unintended`.
 * FACTORY-843 states that preference explicitly: an UNDETERMINABLE cause
 * must resolve to `unintended`, because a wrongly-fresh start only loses
 * work a resume would have kept, while a wrongly-resumed session (the cost
 * a wrong `intentional` verdict risks) is bounded by the sibling story's
 * own token/size cutoff — the cheaper direction to be wrong in.
 */
export function classifyStop(input: {
  stopCause: StopCauseRecord | undefined;
  ticketStatus: string;
  ticketLabels: readonly string[];
}): StopClassification {
  if (input.stopCause !== undefined) return "intentional";
  if (input.ticketStatus === "Done") return "intentional";
  if (input.ticketLabels.includes(EXEMPT_LABEL)) return "intentional";
  return "unintended";
}
