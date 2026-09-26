/**
 * DROVR-42 (host-wiring decision carried over from DROVR-41, under the
 * DROVR-37 epic): a standalone interval timer that calls `@brooswit/drovr`'s
 * `autoAnswerPermissions` once per tick across every Claude pane butchr
 * hosts — presses the "always allow" stored-rule option on an unambiguous
 * tool-permission dialog ("Do you want to proceed?"), so an agent blocked on
 * one is cleared within one tick instead of sitting frozen for hours until a
 * human happens to notice (the frozen-agent incident this whole epic exists
 * to fix, observed on butchr's own fleet).
 *
 * Deliberately its OWN timer, wired separately from every other poll loop in
 * src/daemon/index.ts (the ~15s Jira reconcile loop, the 5s blocking-
 * escalation watcher `blockingEscalationTimer`, the 5s `watchPrompts`
 * startup-dialog answerer) — a reconcile failure must never stall permission-
 * answering, and a wedged permission-answer tick must never stall reconcile.
 * Same in-flight-guard shape as `blockingEscalationTimer` (never run two
 * ticks concurrently against the same pane set), factored out here as its
 * own small, testable module rather than inlined, so `runPermissionAnswerTick`
 * can be unit-tested against a fake client without a real herdr socket.
 *
 * This does NOT overlap with `chooseStartupAnswer` (src/agents/prompt.ts) —
 * that answerer handles Claude's STARTUP dialogs (trust, bypass-permissions
 * first-run, fullscreen-renderer, settings recommendations); it has no case
 * for the "Do you want to proceed?" tool-permission dialog `autoAnswerPermissions`
 * targets, so there is no double-answerer hazard here the way there was for
 * drovr's escalation watcher (see managed-session-escalation-watcher.ts's own
 * doc comment) — nothing else on this fleet presses that dialog's keys.
 */
import { autoAnswerPermissions, type AutoAnswerPermissionResult, type DrovrClient } from "@brooswit/drovr";

/** The slice of `DrovrClient` `autoAnswerPermissions` actually needs — same shape drovr's own `ApprovalClient` type declares, restated here so this module doesn't need a `DrovrClient` import just to read the pick out of it. */
export type PermissionAnswerClient = { agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys"> };

export interface PermissionAnswerLoopDeps {
  client: PermissionAnswerClient;
  /** JSONL audit file — see `Config.permissionAuditPath` (src/config/config.ts) for why this lives under butchr's own state directory rather than drovr's package default. */
  auditPath: string;
  /** Recorded as the audit operator on every attempt. Defaults to drovr's own `"drovr-auto"` when omitted; butchr's daemon wiring (src/daemon/index.ts) passes `"butchr-daemon"` so a shared audit file (or a human comparing hosts) can tell butchr's own unattended pass apart from another caller's. */
  operator?: string;
  /**
   * Deadline for one pane's whole approve attempt — see
   * `AutoAnswerPermissionsOptions.readTimeoutMs`'s own doc comment
   * (`@brooswit/drovr`). Left unset, `autoAnswerPermissions` never times out
   * a pane's attempt on its own; `startPermissionAnswerLoop` below always
   * passes one, set comfortably below its own `intervalMs`, so a wedged pane
   * can never still be in flight when the next tick fires.
   */
  readTimeoutMs?: number;
  /** Free-text daemon log line, one per tick that answered/failed anything, plus one per failed pane. Optional; omitted, this tick's outcomes are simply never logged (a caller with no daemon console to write to). */
  log?: (line: string) => void;
}

/**
 * One pass over every Claude pane: scan for a pending tool-permission
 * dialog, press the unambiguous "always allow" option, and log a one-line
 * summary. Never throws — a rejecting `autoAnswerPermissions` call (the
 * fleet-wide scan itself failing, not a single pane's attempt, which
 * `autoAnswerPermissions` already isolates into a `failed` result per pane)
 * is caught and logged instead, so one bad tick can never take the timer
 * down — same "isolated poll, no ticket suite it could reasonably be tested
 * as a mock of" discipline every other daemon timer in this file's sibling
 * module (`blockingEscalationTimer`, src/daemon/index.ts) already follows.
 */
export async function runPermissionAnswerTick(deps: PermissionAnswerLoopDeps): Promise<readonly AutoAnswerPermissionResult[]> {
  const log = deps.log ?? (() => {});
  try {
    const results = await autoAnswerPermissions(deps.client, {
      auditPath: deps.auditPath,
      ...(deps.operator !== undefined ? { operator: deps.operator } : {}),
      ...(deps.readTimeoutMs !== undefined ? { readTimeoutMs: deps.readTimeoutMs } : {}),
    });
    const answered = results.filter((r) => r.outcome === "answered");
    const failed = results.filter((r) => r.outcome === "failed");
    if (answered.length || failed.length) {
      log(`[permission-answer] ${answered.length} answered, ${results.length - answered.length - failed.length} skipped, ${failed.length} failed`);
      for (const f of failed) log(`[permission-answer] ${f.paneId}${f.label ? ` (${f.label})` : ""} failed: ${f.reason} — ${f.detail}`);
    }
    return results;
  } catch (e) {
    log(`[permission-answer] tick failed: ${(e as Error)?.message ?? e}`);
    return [];
  }
}

/**
 * Wires `runPermissionAnswerTick` onto its own `setInterval`, guarded so two
 * ticks never run concurrently (a slow tick — many panes, a near-deadline
 * approve attempt — simply skips the next firing rather than overlapping
 * it), same shape as `blockingEscalationTimer` (src/daemon/index.ts).
 * `.unref()`'d before returning, same as every other background timer in
 * this codebase, so it can never keep the process alive on its own.
 */
export function startPermissionAnswerLoop(deps: PermissionAnswerLoopDeps, intervalMs: number): ReturnType<typeof setInterval> {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runPermissionAnswerTick(deps).finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
