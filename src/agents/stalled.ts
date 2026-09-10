import type { ObservedAgentLabel } from "../labels/plan.js";

/** Alias kept local for readability — see labels/plan.ts's ObservedAgentLabel. */
export type ObservedLabel = ObservedAgentLabel;

interface Entry {
  /**
   * Start of the CURRENT unbroken idle/done streak, or `null` when no streak
   * is currently running — the last observation was `working`/`blocked`/
   * `none`, or this entry was just created and no `idle` has landed yet.
   * BUTCHR-279: this is the floor, and it is re-armed (set to a fresh
   * `now()`) the moment `idle`/`done` resumes after any break — anchored to
   * "since the agent LAST STOPPED WORKING", not to the ticket's first-ever
   * observation. Re-arming rather than latching is what lets a post-work
   * stall (worked, then went idle/done and stayed there) reach `stalled`;
   * see this class's own doc comment for the guard this preserves instead.
   */
  idleSince: number | null;
}

/**
 * Tracks, per active ticket, whether its agent has been idle/done
 * continuously since it LAST STOPPED WORKING (BUTCHR-279 — previously,
 * incorrectly, since first observed running at all; see git history for
 * that defect). In-memory only — lost on a daemon restart, which is fine:
 * `observe()` just starts a fresh floor from that restart's first poll,
 * which only ever delays the signal.
 *
 * THE GUARD THIS PRESERVES: an agent that is observed `working` (or
 * `blocked`) right now is never a stalled candidate — the very next
 * observation breaks the streak and re-arms the floor. What changed is
 * narrower than it looks: an agent that WAS working earlier but has since
 * gone idle/done for the full window is now reachable too, because the
 * floor tracks the CURRENT streak, not the ticket's history. The guard is
 * "currently working is never stalled", never "has ever worked is never
 * stalled" — the latter was the bug (BUTCHR-272/BUTCHR-279).
 */
export class StalledTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly now: () => number,
    /** Minutes an idle/done streak must hold, uninterrupted, before it's a stalled CANDIDATE (comments not yet considered). */
    private readonly minutes: number,
  ) {}

  /**
   * Record this poll's observation for `issue` and report whether the cheap
   * preconditions for "stalled" hold: continuously idle/done for at least
   * `minutes`, counting from when the CURRENT streak started (last time the
   * agent stopped working — see `Entry.idleSince`). Comments are NOT
   * considered here — the caller only fetches them when this returns true
   * (the cost guard).
   *
   * `working`/`blocked`/`none` all break the current streak and re-arm the
   * floor (so a LATER idle/done observation starts counting from scratch,
   * never immediately qualifies, and never inherits time accrued before the
   * break) — `none` in particular must never qualify on its own, belt and
   * braces alongside `desiredLabels`' own `label === "idle"` gate
   * (src/labels/plan.ts), since a ticket with no agent has no pane at its
   * prompt to read a wake comment.
   */
  observe(issue: string, label: ObservedLabel): boolean {
    let e = this.entries.get(issue);
    if (!e) { e = { idleSince: null }; this.entries.set(issue, e); }
    if (label !== "idle") { e.idleSince = null; return false; }
    if (e.idleSince == null) e.idleSince = this.now();
    return this.now() - e.idleSince >= this.minutes * 60_000;
  }

  /** Drop tracking for a ticket leaving the active set — a later respawn starts a fresh floor. */
  forget(issue: string): void {
    this.entries.delete(issue);
  }

  /**
   * Minutes since `issue`'s CURRENT idle/done streak started (the agent last
   * stopped working — see `Entry.idleSince`), or `null` when there is no
   * streak running right now (never observed, forgotten, a fresh instance
   * after a restart, or the last observation broke the streak). A pure
   * query: never mutates, and distinct from `observe`'s own boolean —
   * BUTCHR-221's stall remediator (src/agents/stall-remediation.ts) reports
   * this in its wake comment instead of fabricating its own number, since
   * its own floor only starts when IT first sees the label applied
   * (typically the very next poll after this tracker's own streak already
   * qualified), which would read as "0 minutes" on every first action
   * otherwise.
   */
  elapsedMinutes(issue: string): number | null {
    const e = this.entries.get(issue);
    return e?.idleSince != null ? Math.round((this.now() - e.idleSince) / 60_000) : null;
  }

  /**
   * The raw instant (same units as `now()` — epoch ms in production) the
   * CURRENT idle/done streak for `issue` started, or `null` when no streak
   * is running right now. BUTCHR-289: `createStalledCheck` needs this exact
   * instant (not `elapsedMinutes`'s rounded duration) to decide whether a
   * comment landed at/after the streak began — exposed here rather than
   * recomputed, since `Entry.idleSince` is already this tracker's own floor.
   */
  streakStart(issue: string): number | null {
    return this.entries.get(issue)?.idleSince ?? null;
  }
}

export interface StalledCheck {
  /**
   * Resolve whether `issue` IS stalled right now (fetches comments only when
   * the cheap preconditions already hold — usually an empty set of
   * tickets). `null` means "could not verify" (the comments fetch failed) —
   * a THIRD outcome, never collapsed into `false`/`true`: the caller
   * (src/labels/sync.ts) must not write or contribute to `agent:stalled` on
   * a poll that returns `null`, and must not treat it as "confirmed not
   * stalled" either.
   */
  check: (issue: string, label: ObservedLabel) => Promise<boolean | null>;
  forget: (issue: string) => void;
  /**
   * See StalledTracker.elapsedMinutes — the genuine measured idle duration,
   * or null if untracked. OPTIONAL, and appended after the two original
   * members rather than folded into a breaking interface change: every
   * existing test fixture in this repo constructs a bare `{ check, forget }`
   * object satisfying `StalledCheck` (test/unit/labels-sync.test.ts,
   * test/unit/stalled.test.ts), and none of them need to grow a third member
   * just to keep compiling. A consumer that wants a real number (BUTCHR-221's
   * stall remediator) must use optional chaining and its own fallback.
   */
  elapsedMinutes?: (issue: string) => number | null;
}

/**
 * BUTCHR-289: the daemon-chatter marker convention every `[butchr:*]`
 * detector already follows (`abandoned.ts`'s `[butchr:abandoned]`,
 * `crash-loop.ts`'s `[butchr:crashloop]`, `escalate.ts`'s `[butchr:blocked]`,
 * `reconcile-failure.ts`'s `[butchr:reconcile]`, `respawn.ts`'s
 * `[butchr:respawn]`, `stall-remediation.ts`'s `[butchr:stall]`, …) —
 * `findMarked` in `src/agents/escalation-helper.ts` relies on the same
 * `body.startsWith(marker)` convention for each one individually; this is
 * the GENERIC prefix all of them share, used here to recognise "any daemon
 * chatter" as a class rather than enumerating every current (and future)
 * marker by name. An agent's own report or a human/boss comment is instead
 * prefixed with a ticket-key identity tag (e.g. `[BUTCHR-272] …`), which
 * never starts with `[butchr:` — verified against real comment bodies (see
 * this ticket's PR description) rather than assumed.
 */
export const DAEMON_CHATTER_PREFIX = "[butchr:";

export interface StalledCheckDeps {
  now: () => number;
  /** N minutes: see StalledTracker. */
  minutes: number;
  /**
   * Recent comments on a ticket; only called for a cheap-precondition
   * candidate. BUTCHR-289: widened from `{ authorEmail }` to `{ id, body,
   * created }` — the daemon already supplies all three via
   * `AtlassianClient.comments` (`src/atlassian/types.ts`'s `JiraComment`),
   * so this needed no daemon rewiring, only this type catching up to what
   * was already there.
   */
  comments: (issue: string) => Promise<readonly { id: string; body: string; created: string }[]>;
  log?: (line: string) => void;
}

/**
 * Builds the stalled check wired into src/labels/sync.ts. An agent that has
 * commented, or that is CURRENTLY working (or blocked), must never be
 * labelled stalled — the streak check (cheap) handles "currently working or
 * blocked breaks the streak, and any streak must hold for the full window";
 * this adds "someone is attending" (I/O, gated behind the streak check so a
 * normal poll over N active tickets costs zero extra Jira requests — the
 * qualifying set is usually empty).
 *
 * BUTCHR-289: "someone is attending" is no longer "a comment from the
 * daemon's account is absent" — the daemon's account and the account every
 * agent comments through are THE SAME credential (`src/daemon/index.ts`
 * wires both from `config.atlassian.email`), so that check could never
 * distinguish the daemon narrating its own state from an agent reporting
 * real progress; verified independently on BUTCHR-272's own comment history
 * (identical `accountId` on a `[butchr:reconcile]` line and that ticket's
 * own `[BUTCHR-272]` report — see this ticket's PR description). The guard
 * now keys on what a comment IS (daemon chatter vs. everything else — see
 * `DAEMON_CHATTER_PREFIX`) and WHEN it arrived (at/after the current idle
 * streak's start, from `StalledTracker.streakStart` — never a recomputed
 * value): a ticket is disqualified only by a non-chatter comment landing
 * during the CURRENT streak, so an old report from before the streak began
 * (e.g. posted right as the agent finished its last turn) does not
 * permanently immunise the ticket, and disqualification re-anchors — rather
 * than lasts forever — every time the streak breaks and re-arms.
 */
export function createStalledCheck(deps: StalledCheckDeps): StalledCheck {
  const tracker = new StalledTracker(deps.now, deps.minutes);
  // BUTCHR-289 DoD 6: which comment disqualified a candidate, logged once
  // per disqualifying comment (not every ~15s poll a still-disqualified
  // ticket re-enters this branch) — mirrors stall-remediation.ts's
  // `loggedFailure`/`cappedLogged` flood discipline. Cleared whenever the
  // ticket leaves candidacy (streak breaks) or stops being disqualified, so
  // a later, genuinely new disqualification logs fresh rather than staying
  // silent because SOME comment was already logged once, long ago.
  const declineLogged = new Map<string, string>();
  return {
    async check(issue, label) {
      if (!tracker.observe(issue, label)) {
        declineLogged.delete(issue);
        return false;
      }
      // observe() just returned true, so a streak is definitely running.
      const streakStart = tracker.streakStart(issue)!;
      try {
        const rows = await deps.comments(issue);
        // Newest-first (AtlassianClient.comments' own `orderBy: -created`),
        // so `.find` surfaces the most recent disqualifying evidence first
        // when more than one qualifies — the most informative one to log.
        //
        // An unparseable `created` (AtlassianClient.comments defaults a
        // missing one to `""`, and `Date.parse("")` is `NaN`) must NOT
        // silently fall through `NaN >= streakStart` (always false) into
        // "did not land during the streak" — that would collapse "I cannot
        // tell when this comment arrived" into a confident "no", the exact
        // defect this file's own `catch` block below exists to avoid for a
        // failed fetch. Fail toward DISQUALIFYING instead (we cannot rule
        // out that someone is attending) — the safe direction, since a
        // false wake costs one debounced comment (see
        // stall-remediation.ts) while a false silence costs nothing
        // visible at all.
        const disqualifying = rows.find((c) => {
          if (c.body.startsWith(DAEMON_CHATTER_PREFIX)) return false;
          const createdAt = Date.parse(c.created);
          return Number.isNaN(createdAt) || createdAt >= streakStart;
        });
        if (disqualifying) {
          if (declineLogged.get(issue) !== disqualifying.id) {
            declineLogged.set(issue, disqualifying.id);
            const unparseable = Number.isNaN(Date.parse(disqualifying.created));
            deps.log?.(
              unparseable
                ? `WARNING: [stalled] ${issue} declined: comment ${disqualifying.id} has an unparseable created field (${JSON.stringify(disqualifying.created)}) — cannot rule out it landed during the current idle streak (started ${new Date(streakStart).toISOString()}), treating as disqualifying rather than guessing`
                : `[stalled] ${issue} declined: comment ${disqualifying.id} (${disqualifying.created}) is not daemon chatter and landed at/after the current idle streak began (${new Date(streakStart).toISOString()}) — someone is attending`,
            );
          }
          return false;
        }
        declineLogged.delete(issue);
        return true;
      } catch (e) {
        // A failed fetch is NOT "zero comments" — that would silently turn
        // into a confident `agent:stalled` on a ticket we simply couldn't
        // check (the defect this ticket exists to remove; see M4 in this
        // ticket's own doc, and src/agents/parked.ts /
        // src/agents/escalation-loop.ts for the house convention this
        // brings stalled.ts into line with). `null` propagates "could not
        // verify" to the caller instead.
        deps.log?.(`WARNING: [stalled] ${issue} comments fetch failed: ${(e as Error)?.message ?? e}`);
        return null;
      }
    },
    forget: (issue) => { tracker.forget(issue); declineLogged.delete(issue); },
    elapsedMinutes: (issue) => tracker.elapsedMinutes(issue),
  };
}
