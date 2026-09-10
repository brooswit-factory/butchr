import type { ObservedAgentLabel } from "../labels/plan.js";

/** Alias kept local for readability — see labels/plan.ts's ObservedAgentLabel. */
export type ObservedLabel = ObservedAgentLabel;

interface Entry {
  /**
   * Daemon's first observation of this ticket's agent running. NOT the
   * ticket's true spawn time on a fresh daemon (that's unknowable without
   * persistence) — using the daemon's own first observation as the floor is
   * conservative: it can only delay the stalled signal, never fabricate one.
   */
  firstObservedAt: number;
  /** Latched permanently once the agent is observed in any state other than idle/done — "is or has been working" (or blocked) must never be labelled stalled. */
  streakBroken: boolean;
}

/**
 * Tracks, per active ticket, whether its agent has been idle/done
 * continuously since first observed running. In-memory only — lost on a
 * daemon restart, which is fine: `observe()` just starts a fresh floor from
 * that restart's first poll, which only ever delays the signal.
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
   * preconditions for "stalled" hold: continuously idle/done since first
   * observed, for at least `minutes`. Comments are NOT considered here — the
   * caller only fetches them when this returns true (the cost guard).
   */
  observe(issue: string, label: ObservedLabel): boolean {
    let e = this.entries.get(issue);
    if (!e) { e = { firstObservedAt: this.now(), streakBroken: false }; this.entries.set(issue, e); }
    if (label !== "idle") { e.streakBroken = true; return false; }
    if (e.streakBroken) return false;
    return this.now() - e.firstObservedAt >= this.minutes * 60_000;
  }

  /** Drop tracking for a ticket leaving the active set — a later respawn starts a fresh "since spawn" floor. */
  forget(issue: string): void {
    this.entries.delete(issue);
  }

  /**
   * Minutes since `issue`'s floor started (its first observation running,
   * per `observe`'s own doc comment) — the genuine, measured idle-since-
   * spawn duration, or `null` if untracked (never observed, forgotten, or a
   * fresh instance after a restart). A pure query: never mutates, and
   * distinct from `observe`'s own boolean — BUTCHR-221's stall remediator
   * (src/agents/stall-remediation.ts) reports this in its wake comment
   * instead of fabricating its own number, since its own floor only starts
   * when IT first sees the label applied (typically the very next poll
   * after this tracker's own streak already qualified), which would read as
   * "0 minutes" on every first action otherwise.
   */
  elapsedMinutes(issue: string): number | null {
    const e = this.entries.get(issue);
    return e ? Math.round((this.now() - e.firstObservedAt) / 60_000) : null;
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

export interface StalledCheckDeps {
  now: () => number;
  /** N minutes: see StalledTracker. */
  minutes: number;
  /** Recent comments on a ticket; only called for a cheap-precondition candidate. */
  comments: (issue: string) => Promise<readonly { authorEmail: string | null }[]>;
  /** The daemon's own Atlassian account — a comment from any OTHER author never disqualifies "stalled" (a human nudging a silent ticket doesn't mean the AGENT spoke). */
  accountEmail: string;
  log?: (line: string) => void;
}

/**
 * Builds the stalled check wired into src/labels/sync.ts. An agent that has
 * commented, or that is or has been working (or blocked), must never be
 * labelled stalled — the streak check (cheap) handles "has been working";
 * this adds "has commented" (I/O, gated behind the streak check so a normal
 * poll over N active tickets costs zero extra Jira requests — the qualifying
 * set is usually empty).
 */
export function createStalledCheck(deps: StalledCheckDeps): StalledCheck {
  const tracker = new StalledTracker(deps.now, deps.minutes);
  return {
    async check(issue, label) {
      if (!tracker.observe(issue, label)) return false;
      try {
        const rows = await deps.comments(issue);
        return !rows.some((c) => c.authorEmail === deps.accountEmail);
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
    forget: (issue) => tracker.forget(issue),
    elapsedMinutes: (issue) => tracker.elapsedMinutes(issue),
  };
}
