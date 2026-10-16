/**
 * FACTORY-501 (FACTORY-500 item 2, option b — "defer-and-escalate") — a
 * herdr-restored pane whose agent stays mid-turn makes `herd.resumeInPlace()`
 * return `"deferred"` (or `"stuck"`) on every poll, forever: `src/daemon/loop.ts`
 * NEVER falls back to `stop()`+`spawn()` on this path (a `"deferred"` outcome
 * is returned at herdr's own `isIdle()` check, BEFORE any `/exit` is sent, so
 * a fresh spawn there would destroy the conversation of an agent that merely
 * stayed busy — see FACTORY-500's approved proposal). Left unaddressed, that
 * agent runs indefinitely without butchr's `--permission-mode`,
 * `--mcp-config`, or channels — alive, but silently degraded, with no bound
 * and no notice.
 *
 * This module makes that visible WITHOUT ever touching the retry itself: it
 * is a pure observer, mirroring `crash-loop.ts`'s own "audible-only, never
 * suppresses the thing it watches" shape. `src/daemon/loop.ts` calls this
 * module's `check` once per poll with the list of issues CURRENTLY found
 * restored-pane-`"deferred"`/`"stuck"` (never with model/effort-only
 * deferrals — see `ReconcileOptions.checkRestoredPaneDeferred`'s own doc
 * comment for exactly where that split happens) and never consults the
 * return value.
 *
 * WALL-CLOCK, NOT POLL COUNT: the issue tier and the managed-sessions tier
 * poll at different cadences (15s vs. `MANAGED_SESSIONS_POLL_MS`), and a
 * poll-counted threshold (like the existing `RESUME_WAITING_NOTICE_AT_POLLS`
 * model/effort notice) would fire at a different WALL-CLOCK delay on each —
 * wrong for an escalation whose whole point is "a human should hear about
 * this after roughly this much real time". `RestoredPaneEscalationTracker`
 * below tracks the wall-clock instant of each id's FIRST consecutive
 * deferral and compares against an injectable `now()`, exactly like
 * `crash-loop.ts`'s own `CrashLoopDetectorDeps.now`.
 *
 * RESET ON "NO LONGER STALE", FOR FREE: unlike `crash-loop.ts` (which prunes
 * on `desired`, since a crash-looping id keeps leaving and re-entering
 * `plan.spawn`), THIS module's `check` is handed the exact set of ids
 * currently deferred/stuck on the restored-pane path — an id that resolves
 * (resumes, becomes genuinely unresumable, or simply stops being found
 * stale) is absent from that list on the very next poll. `forgetMissing`
 * prunes to exactly that set every call, so a later, genuinely NEW deferral
 * streak for the same id starts a fresh clock with no separate "terminal
 * outcome" signal needed — the caller's per-poll list IS that signal.
 *
 * REPEATING, NOT ONE-SHOT: after the first escalation at
 * `RESTORED_PANE_ESCALATION_FIRST_MS`, a later escalation repeats every
 * `RESTORED_PANE_ESCALATION_REPEAT_MS` for as long as the SAME streak
 * continues — an agent that stays degraded for hours does not go quiet
 * after one notice, unlike the model/effort path's deliberately-once
 * `onResumeWaiting`.
 *
 * NO JIRA TICKET FOR EVERY CALLER: a managed-session agent (buddy, genius —
 * the canary set this story gates widening beyond) has no Jira ticket to
 * comment on at all. `addComment` is caller-supplied exactly like
 * `crash-loop.ts`'s own dep of the same name — `src/daemon/index.ts` wires a
 * real Jira comment for the issue/rule-agent path and a journal-log-only
 * stand-in for the managed-session path, mirroring
 * `managedSessionCrashLoopDetector`'s existing wiring exactly.
 */

/** Marker every escalation this module writes starts with — distinct from `RESUME_MARKER`/`RESPAWN_MARKER` (src/agents/respawn.ts) so a post-mortem can grep for this specific condition. */
export const RESTORED_PANE_ESCALATION_MARKER = "[butchr:restored-degraded]";

/**
 * FACTORY-501 — how long a restored pane may stay deferred/stuck before the
 * FIRST escalation. Default ~10 minutes: long enough that an agent merely
 * finishing an ordinary turn (or a brief dialog) never trips it — at the
 * issue tier's 15s poll cadence that's dozens of consecutive polls — short
 * enough that a human hears about a genuinely long-stuck restored pane well
 * before it has been degraded for hours unnoticed.
 */
export const RESTORED_PANE_ESCALATION_FIRST_MS = 10 * 60_000;

/**
 * FACTORY-501 — how often the escalation repeats after the first notice, for
 * as long as the SAME deferral streak continues. Default ~1 hour: frequent
 * enough that a sustained degradation is not forgotten between notices,
 * infrequent enough not to spam the ticket/journal with a fact already
 * reported.
 */
export const RESTORED_PANE_ESCALATION_REPEAT_MS = 60 * 60_000;

/**
 * Per-id wall-clock state: the instant of the first deferral in the CURRENT
 * streak, and the instant of the last escalation posted for it (if any) —
 * deliberately a SEPARATE structure from `ResumeDeferGuard`
 * (src/daemon/loop.ts), which tracks the unrelated, poll-counted,
 * once-only model/effort notice. Never persisted across a daemon restart —
 * a restart can only ever DELAY the next escalation (the streak's clock
 * restarts from the first deferral observed after the restart), the same
 * "delay, never fabricate" trade-off every in-memory tracker in this
 * codebase already makes.
 */
export class RestoredPaneEscalationTracker {
  private readonly firstDeferredAt = new Map<string, number>();
  private readonly lastEscalatedAt = new Map<string, number>();

  /** Drop tracking for any id not in `stillDeferred` this poll — see this module's own top comment for why this alone implements "reset on terminal outcome or no-longer-stale". */
  forgetMissing(stillDeferred: ReadonlySet<string>): void {
    for (const id of [...this.firstDeferredAt.keys()]) {
      if (!stillDeferred.has(id)) {
        this.firstDeferredAt.delete(id);
        this.lastEscalatedAt.delete(id);
      }
    }
  }

  /** Record a deferred/stuck poll for `id` at wall-clock `at`; returns ms elapsed since the FIRST deferral of the current streak (0 on the very first). */
  recordDeferral(id: string, at: number): number {
    let first = this.firstDeferredAt.get(id);
    if (first === undefined) {
      first = at;
      this.firstDeferredAt.set(id, first);
    }
    return at - first;
  }

  /** Whether `id` is due an escalation right now: true the first time `elapsedMs` crosses `firstThresholdMs`, then again every `repeatIntervalMs` after the last escalation actually posted. */
  dueFor(id: string, at: number, elapsedMs: number, firstThresholdMs: number, repeatIntervalMs: number): boolean {
    if (elapsedMs < firstThresholdMs) return false;
    const last = this.lastEscalatedAt.get(id);
    return last === undefined || at - last >= repeatIntervalMs;
  }

  /** Latch `id` as escalated as of `at` — call only once an escalation has actually been posted/logged for it. */
  markEscalated(id: string, at: number): void {
    this.lastEscalatedAt.set(id, at);
  }
}

/**
 * Deliberately explicit about all three required facts (FACTORY-500 item 2,
 * acceptance criterion 2 / FACTORY-501's own DoD): how long the agent has
 * been unable to take butchr's flags, that it is running degraded without
 * them, and that no conversation was discarded. Wording is kept distinct
 * from `resumePreservedComment`/`respawnComment` (src/agents/respawn.ts) and
 * from the `onResumeWaiting` model/effort notice
 * (`src/daemon/index.ts`) — different marker, different phrasing, never a
 * "session lost: ..." string — so a post-mortem can count this condition
 * separately from either.
 */
export function restoredPaneEscalationComment(agent: string, elapsedMs: number, atIso: string): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return `${RESTORED_PANE_ESCALATION_MARKER} ${agent} has been unable to take butchr's full flag set for ~${minutes} minute(s), as of ${atIso}. It was restored by herdr after a host reset as a bare \`claude --resume\`, and every poll since has found its pane still mid-turn (deferred) or otherwise not back to a shell (stuck) — butchr is retrying the relaunch with --permission-mode, --mcp-config, and its channels on every poll, but has not yet succeeded. It is running DEGRADED without those flags, but its conversation has NOT been discarded and nothing about it has been interrupted; butchr will keep retrying on this path rather than force a fresh spawn. This notice repeats periodically for as long as this continues.`;
}

export interface RestoredPaneEscalationDetectorDeps {
  now: () => number;
  /** Overrides `RESTORED_PANE_ESCALATION_FIRST_MS` — test seam only; production omits this. */
  firstThresholdMs?: number;
  /** Overrides `RESTORED_PANE_ESCALATION_REPEAT_MS` — test seam only; production omits this. */
  repeatIntervalMs?: number;
  /** Post (or log, for an agent with no ticket — see this module's own top comment) the escalation for `id`. */
  addComment: (id: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface RestoredPaneEscalationDetector {
  /**
   * One poll's worth of detection. `deferred` is the exact set of ids
   * `src/daemon/loop.ts` found restored-pane-`"deferred"`/`"stuck"` THIS
   * poll — never filtered, delayed, or unioned with a prior poll's set by
   * this call. Returns nothing and is never consulted for control flow
   * (audible-only, same as `crash-loop.ts`). Never throws.
   */
  check: (deferred: readonly string[]) => Promise<void>;
}

/** Builds the detector wired into `ReconcileOptions.checkRestoredPaneDeferred` (src/daemon/loop.ts), called once per poll after the respawn loop. */
export function createRestoredPaneEscalationDetector(deps: RestoredPaneEscalationDetectorDeps): RestoredPaneEscalationDetector {
  const tracker = new RestoredPaneEscalationTracker();
  const firstThresholdMs = deps.firstThresholdMs ?? RESTORED_PANE_ESCALATION_FIRST_MS;
  const repeatIntervalMs = deps.repeatIntervalMs ?? RESTORED_PANE_ESCALATION_REPEAT_MS;
  const log = (line: string) => deps.log?.(line);

  async function check(deferred: readonly string[]): Promise<void> {
    try {
      tracker.forgetMissing(new Set(deferred));
      for (const id of deferred) {
        const at = deps.now();
        const elapsed = tracker.recordDeferral(id, at);
        if (!tracker.dueFor(id, at, elapsed, firstThresholdMs, repeatIntervalMs)) continue;
        tracker.markEscalated(id, at);
        const text = restoredPaneEscalationComment(id, elapsed, new Date(at).toISOString());
        await deps.addComment(id, text).catch((e) =>
          log(`WARNING: [restored-pane-escalation] escalation notice failed for ${id}: ${(e as Error)?.message ?? e}`));
        log(`[restored-pane-escalation] ${id} still deferred after ~${Math.round(elapsed / 60_000)}m — escalation posted`);
      }
    } catch (e) {
      log(`WARNING: [restored-pane-escalation] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
