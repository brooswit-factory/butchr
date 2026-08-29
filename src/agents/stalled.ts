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
}

export interface StalledCheck {
  /** Resolve whether `issue` IS stalled right now (fetches comments only when the cheap preconditions already hold — usually an empty set of tickets). */
  check: (issue: string, label: ObservedLabel) => Promise<boolean>;
  forget: (issue: string) => void;
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
      const rows = await deps.comments(issue).catch((e) => {
        deps.log?.(`[stalled] ${issue} comments fetch failed: ${(e as Error)?.message ?? e}`);
        return [] as readonly { authorEmail: string | null }[];
      });
      return !rows.some((c) => c.authorEmail === deps.accountEmail);
    },
    forget: (issue) => tracker.forget(issue),
  };
}
