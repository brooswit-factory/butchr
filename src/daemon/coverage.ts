/**
 * BUTCHR-179: makes "could not check" reportable, on a surface a reader
 * actually consults, for any detector that DECLINES to assert rather than
 * fetching successfully and finding nothing.
 *
 * THE GAP THIS CLOSES: `src/agents/stalled.ts` (and five other modules —
 * `parked.ts`, `frozen-asleep.ts`, `crash-loop.ts`, `reconcile-failure.ts`,
 * `escalation-loop.ts`) already treat a failed comments/links fetch as a
 * THIRD outcome, never collapsed into "confirmed clean" — that fix
 * (BUTCHR-121 and predecessors) was correct and stays. But every one of
 * those modules expresses the third outcome as, at most, a `WARNING` log
 * line plus the absence of a write. A log line is not a surface a reader
 * consults (`journalctl | grep WARNING` requires already suspecting
 * something is wrong) — so nothing a reader CAN see distinguishes "this
 * ticket was checked and is fine" from "this ticket was never checked this
 * poll". This module is the shared, name-agnostic recorder that lets any
 * declining detector report through the SAME mechanism, surfaced on
 * `/health` (see `combineHealth`'s `coverage` param) as a sibling field —
 * never routed back through Jira/Confluence, the channel that just failed
 * (trap 1), never per-ticket (trap 2 — this counts EVENTS, not tickets, and
 * carries no ticket keys), and never a reason to make any detector fail
 * closed (trap 3 — this module only ever records what already happened; it
 * has no opinion on what a detector should assert).
 *
 * GENERAL BY CONSTRUCTION: `recordChecked`/`recordDeclined` take a caller-
 * supplied `name` — this module never enumerates or imports the detectors
 * that call it. Wiring a new detector through it is exactly two calls (one
 * on the success path, one on the decline path) at whatever `try`/`catch`
 * or `=== null` guard already exists — see the call sites in
 * `src/labels/sync.ts` and `src/agents/escalation-loop.ts` for the shape.
 */

export interface DetectorCoverage {
  /** The name a detector registers itself under — e.g. "stalled", "escalation:unresponsive". Caller-chosen; this module never validates it against a known set. */
  name: string;
  /** Count of `recordChecked(name)` calls since the daemon started — a fetch that ran and resolved, whether or not it found anything. */
  checkedCount: number;
  /** Count of `recordDeclined(name)` calls since the daemon started — a fetch that could not be completed (rejected, or an equivalent fail-closed guard). */
  declinedCount: number;
  /** ISO timestamp of the most recent `recordDeclined(name)` call, or null if this detector has never declined. */
  lastDeclinedAt: string | null;
}

export interface CoverageRecorder {
  /** Call once a detector's verification fetch resolves — found, or genuinely confirmed not-found. Never call this for a declined attempt. */
  recordChecked(name: string): void;
  /** Call once a detector's verification fetch could not be completed — the THIRD outcome, never "confirmed clean". */
  recordDeclined(name: string): void;
}

export interface CoverageTracker extends CoverageRecorder {
  /** Every name ever recorded, most-recently-declined first among those with a decline, then the rest in first-seen order — order is not load-bearing, callers should sort/filter as they need. */
  snapshot(): DetectorCoverage[];
}

/**
 * In-memory only, like every other liveness tracker in this daemon
 * (`StalledTracker`, `LoopHealth`) — lost on restart, which is fine: a
 * restart starting the counts fresh only ever costs the operator a shorter
 * lookback window, never a false "declined" or a false "clean".
 */
export function createCoverageTracker(now: () => number = Date.now): CoverageTracker {
  const entries = new Map<string, { checkedCount: number; declinedCount: number; lastDeclinedAt: number | null }>();

  const entryFor = (name: string) => {
    let e = entries.get(name);
    if (!e) { e = { checkedCount: 0, declinedCount: 0, lastDeclinedAt: null }; entries.set(name, e); }
    return e;
  };

  return {
    recordChecked(name) {
      entryFor(name).checkedCount++;
    },
    recordDeclined(name) {
      const e = entryFor(name);
      e.declinedCount++;
      e.lastDeclinedAt = now();
    },
    snapshot() {
      return [...entries.entries()].map(([name, e]) => ({
        name,
        checkedCount: e.checkedCount,
        declinedCount: e.declinedCount,
        lastDeclinedAt: e.lastDeclinedAt === null ? null : new Date(e.lastDeclinedAt).toISOString(),
      }));
    },
  };
}
