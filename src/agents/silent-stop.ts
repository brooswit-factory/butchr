import type { ObservedAgentLabel } from "../labels/plan.js";

/** Alias kept local for readability — see labels/plan.ts's ObservedAgentLabel. */
export type ObservedLabel = ObservedAgentLabel;

/**
 * PR #692 review: herdr's agent_status flickers (src/labels/sync.ts's own
 * `AgentLabelStabilizer` doc comment: "flapping working/blocked/working
 * within seconds", observed live). A single idle/none poll sandwiched
 * between two working/blocked polls is noise, not a stop — exactly the
 * condition that stabilizer already guards the AGENT:* LABEL against by
 * requiring the SAME candidate value on two consecutive polls before it
 * applies. This detector guards its own STOP EVENT the same way, for the
 * same reason: a measurement whose whole purpose is the false-positive
 * rate must not manufacture one out of its own debouncing gap.
 */
const STOP_CONFIRM_POLLS = 2;

interface Entry {
  /**
   * Instant the CURRENT working/blocked episode started, or `null` when no
   * episode has ever been observed (a fresh entry, or a ticket that has only
   * ever been seen idle/none). Re-armed to a fresh `now()` the moment
   * `working`/`blocked` resumes after a reported stop, so a LATER stop's
   * "since" window always starts from the most recent resume — never from an
   * earlier episode, and never accumulating across stops. NOT reset by a
   * single-poll idle/none flicker that never reaches `STOP_CONFIRM_POLLS` —
   * see `pendingStopPolls` below.
   */
  activeSince: number | null;
  /**
   * Whether the episode that most recently ended (if any) has already
   * produced its one stop event. This is the dedup DoD requires: once a stop
   * is reported, every later poll that still observes idle/none for the SAME
   * episode must report nothing, not log a line per ~15s tick.
   */
  reported: boolean;
  /**
   * Consecutive idle/none observations seen so far since the last
   * working/blocked observation, reset to 0 the instant working/blocked
   * resumes. A stop is reported only once this reaches `STOP_CONFIRM_POLLS`
   * — the SAME two-consecutive-polls debounce `AgentLabelStabilizer` already
   * applies to the agent:* label itself (src/labels/sync.ts), applied here
   * to this detector's own stop event instead of a label write.
   */
  pendingStopPolls: number;
}

/**
 * Tracks, per active ticket, the instant its agent most recently
 * started/resumed being "active" (working OR blocked), and reports the
 * working/blocked -> idle/none transition ("a stop") exactly once per
 * episode. In-memory only — lost on a daemon restart, which is fine:
 * `observe()` just starts a fresh episode from that restart's first
 * `working`/`blocked` observation, which can only ever delay or suppress a
 * signal, never fabricate one (a ticket already idle/none across a restart
 * has no `activeSince` to report a stop from).
 *
 * BLOCKED COUNTS AS ACTIVE, DELIBERATELY, UNLIKE src/agents/stalled.ts's
 * StalledTracker: that tracker asks "has nobody attended this ticket for N
 * minutes", and a blocked agent isn't attending either, so blocked correctly
 * breaks ITS streak. This tracker asks a narrower question — "did the
 * agent's session end or go idle (a STOP) without it having spoken since it
 * last started/resumed" — and an agent sitting `blocked` (paused on a dialog
 * answer) has not stopped. Folding `blocked` into the same episode as
 * `working` means a working -> blocked -> working run never fires a false
 * stop, and a working -> blocked -> idle run's "since" window still starts
 * from when work began, not from whenever the blocked wait happened to end.
 */
export class SilentStopTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /**
   * Record this poll's observation for `issue`. Returns the instant the
   * episode that JUST ended began, once the working/blocked -> idle/none
   * transition has held for `STOP_CONFIRM_POLLS` consecutive polls — `null`
   * on every other poll, including: every poll while the agent is currently
   * active, a single idle/none poll that hasn't yet confirmed (flicker), and
   * every later poll once the stop has already been reported (the dedup
   * this module exists to guarantee).
   */
  observe(issue: string, label: ObservedLabel): { episodeStart: number } | null {
    let e = this.entries.get(issue);
    if (!e) {
      e = { activeSince: null, reported: true, pendingStopPolls: 0 };
      this.entries.set(issue, e);
    }
    const active = label === "working" || label === "blocked";
    if (active) {
      if (e.reported || e.activeSince == null) e.activeSince = this.now();
      e.reported = false;
      e.pendingStopPolls = 0; // a flicker back to active cancels any pending (unconfirmed) stop
      return null;
    }
    if (e.reported || e.activeSince == null) return null; // already reported this stop, or never was active
    e.pendingStopPolls += 1;
    if (e.pendingStopPolls < STOP_CONFIRM_POLLS) return null; // not yet confirmed — could still be a flicker
    e.reported = true;
    return { episodeStart: e.activeSince };
  }

  /** Drop tracking for a ticket leaving the active set — a later respawn starts a fresh episode. */
  forget(issue: string): void {
    this.entries.delete(issue);
  }
}

/**
 * BUTCHR/FACTORY-740 DoD 3: a daemon restart or a herdr wedge makes many
 * workers surface as idle/none at once, through no fault of their own — see
 * this ticket's epic (FACTORY-734 plan, Story 4 risk) and FACTORY-738's
 * amended description. Two distinct discontinuities must each start a fresh
 * suppression window:
 *
 *  - DAEMON START: this tracker is constructed exactly once per daemon
 *    process (same lifetime as `SilentStopTracker` and
 *    src/agents/stalled.ts's `StalledTracker`), so its own construction
 *    instant IS "since the daemon started" — no separate signal needed.
 *  - HERDR RECONNECT: `check()` below is only ever reached from inside
 *    src/labels/sync.ts's `syncLabels`, AFTER `deps.agentStatuses()` (which
 *    calls `herdr.agent.list()`) has already succeeded for this poll — a
 *    failure there throws and aborts the WHOLE poll before any `check()`
 *    call is reached (src/daemon/index.ts's `agentStatusesFeedingDashboard`
 *    top comment: "nothing in syncLabels catches it"). So while herdr is
 *    unreachable, THIS component simply isn't invoked at all — the gap
 *    between consecutive invocations is directly observable from inside the
 *    component itself, with no new daemon-side wiring required. A gap much
 *    larger than the daemon's own ~15s issue-loop poll cadence
 *    (src/labels/sync.ts; also documented against `abandonedMinutes` in
 *    src/config/config.ts) can only mean the poll loop itself stalled or
 *    errored repeatedly — a herdr wedge/reconnect, or the daemon pausing for
 *    some other reason — never ordinary jitter.
 */
const DISCONTINUITY_GAP_MS = 90_000; // 6x the ~15s poll cadence: well past ordinary jitter, well short of a real stall going unnoticed.

export interface SilentStopContext {
  /** Best-effort, for the log line only — NEVER gates flag/no-flag. `undefined` when the caller doesn't know (e.g. PR tracking is disabled). */
  prOpen?: boolean;
}

export interface SilentStopCheck {
  /**
   * Observes this poll's label for `issue`. When a stop (working/blocked ->
   * idle/none) just happened, and that stop did not land within the
   * restart/reconnect suppression window (see this module's own top
   * comment), fetches comments and, if none of them is this ticket's OWN
   * agent speaking at/after the episode's start, logs exactly one dry-run
   * line: `[silent-stop] would flag ${issue} ...`.
   *
   * DRY-RUN ONLY: this function never writes Jira — no comment, no label, no
   * transition, no escalation, no wake — regardless of outcome. That is the
   * entire point of FACTORY-740 (measure the false-positive rate before
   * FACTORY-736 wires up anything that acts on this signal).
   */
  check: (issue: string, label: ObservedLabel, context?: SilentStopContext) => Promise<void>;
  forget: (issue: string) => void;
}

export interface SilentStopCheckDeps {
  now: () => number;
  /**
   * Minutes after a daemon start or a detected herdr-reconnect gap (see
   * DISCONTINUITY_GAP_MS above) during which a stop is suppressed — logged
   * as "suppressed", never as a flag, and never fetches comments for it
   * (cost guard: a restart that wakes every active ticket at once must not
   * also burn one comments fetch per ticket). FACTORY-736 inherits this same
   * knob when it flips the enforcing path on.
   */
  suppressMinutes: number;
  /** Same shape src/agents/stalled.ts's StalledCheckDeps uses — AtlassianClient.comments' own JiraComment subset. */
  comments: (issue: string) => Promise<readonly { id: string; body: string; created: string }[]>;
  log?: (line: string) => void;
}

/**
 * FACTORY-740: "posted a new comment on its own ticket" is this ticket's OWN
 * agent speaking, not merely any comment landing on the ticket. Every
 * comment this agent itself posts (`jira_add_comment`, `report_to_boss`,
 * `ask_boss`, ...) is tagged `[${issue}] ` by `tagComment`
 * (src/tools/relationship.ts — verified directly against that file, not
 * assumed), where `issue` is THIS ticket's own key; a boss's `tell_worker` or
 * a peer's sideways note is tagged with the SENDER's own key instead, never
 * this ticket's, and a raw human edit is untagged. Filtering on the exact
 * `[${issue}] ` prefix is therefore both the "own identity" test and (since
 * daemon chatter is tagged `[butchr:...]`, never `[${issue}] `) a strictly
 * narrower, more accurate stand-in for src/agents/stalled.ts's coarser
 * "exclude daemon chatter" convention — appropriate for THAT module's
 * different question ("is anyone attending"), but not what this ticket's own
 * wording asks for ("no new comment from the WORKER'S OWN identity").
 *
 * An unparseable `created` field is treated as "cannot rule out it landed
 * during the episode" — fails toward NOT flagging (the same direction
 * stalled.ts fails for the same defect class), the safe one for a dry-run
 * whose whole purpose is measuring false positives, never manufacturing one.
 * Likewise, a failed comments fetch never flags — see the `catch` below.
 */
export function createSilentStopCheck(deps: SilentStopCheckDeps): SilentStopCheck {
  const tracker = new SilentStopTracker(deps.now);
  let lastInvokedAt: number | null = null;
  let lastDiscontinuityAt = deps.now(); // daemon start: see this module's own top comment.

  return {
    async check(issue, label, context) {
      const nowMs = deps.now();
      if (lastInvokedAt != null && nowMs - lastInvokedAt > DISCONTINUITY_GAP_MS) lastDiscontinuityAt = nowMs;
      lastInvokedAt = nowMs;

      const stop = tracker.observe(issue, label);
      if (!stop) return;

      const suppressedForMs = deps.suppressMinutes * 60_000;
      if (nowMs - lastDiscontinuityAt <= suppressedForMs) {
        deps.log?.(
          `[silent-stop] ${issue} stop suppressed: within ${deps.suppressMinutes}m of a daemon start/herdr-reconnect (at ${new Date(lastDiscontinuityAt).toISOString()}) — not evaluated`,
        );
        return;
      }

      const selfTag = `[${issue}] `;
      try {
        const rows = await deps.comments(issue);
        const attended = rows.some((c) => {
          if (!c.body.startsWith(selfTag)) return false;
          const createdAt = Date.parse(c.created);
          return Number.isNaN(createdAt) || createdAt >= stop.episodeStart;
        });
        if (attended) return;
        const minutes = Math.round((nowMs - stop.episodeStart) / 60_000);
        const prPart = context?.prOpen === undefined ? "unknown" : context.prOpen ? "yes" : "no";
        deps.log?.(
          `[silent-stop] would flag ${issue} (no [${issue}]-tagged comment since the episode that just ended started ${new Date(stop.episodeStart).toISOString()}, ~${minutes}m ago; pr open=${prPart})`,
        );
      } catch (e) {
        deps.log?.(`WARNING: [silent-stop] ${issue} comments fetch failed: ${(e as Error)?.message ?? e} — cannot verify, not flagging`);
      }
    },
    forget: (issue) => tracker.forget(issue),
  };
}
