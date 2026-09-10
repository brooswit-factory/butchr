import { detectSessionLimitRefusal } from "./session-limit.js";
import type { AgentRow } from "./session-limit-watch.js";

/**
 * BUTCHR-221 criterion 10 — a synchronous "is this issue quota-blocked right
 * now" predicate for src/agents/stall-remediation.ts's `quotaBlocked` dep,
 * built WITHOUT a second detection path and WITHOUT touching session-limit.ts
 * or session-limit-watch.ts. This module never reads a pane and never parses
 * a banner itself: it TEES the exact `list`/`read` functions
 * src/daemon/index.ts already hands to `watchSessionLimits` — same poll,
 * same pane text, same `detectSessionLimitRefusal` recogniser
 * (session-limit.ts, untouched) — through this wrapper first, and keeps its
 * own small map of the last observation per issue. Wire `createQuotaGate`'s
 * `list`/`read` into `watchSessionLimits` in place of the underlying
 * functions; `watchSessionLimits` itself needs no change and no knowledge
 * that this exists.
 *
 * Deliberately SYNCHRONOUS (`quotaBlocked?: (issue: string) => boolean` on
 * `StallRemediationDeps`) — stall-remediation.ts calls this from inside a
 * per-issue poll and must not do I/O to answer it. The freshness this trades
 * for is exactly `watchSessionLimits`' own 15s poll interval and its
 * idle/done-only read gate — the same staleness the rest of that module
 * already lives with, not a new one.
 *
 * Read-only by construction: never closes a pane, never logs, never writes
 * anything. Recovering a quota-parked pane is session-limit-watch.ts's job
 * (BUTCHR-241), not this module's.
 */
export interface QuotaGate {
  /**
   * True iff the LAST observed pane read for `issue` (idle/done agents
   * only — a working/blocked agent's pane is never read, by
   * `watchSessionLimits`'s own cost gate, so its last-known state simply
   * holds) matched the session-limit refusal. False for an issue never
   * observed, or last observed clear.
   */
  isBlocked: (issue: string) => boolean;
  /** Drop-in replacement for the `list` handed to `watchSessionLimits` — records each poll's rows so `read` below can resolve a `pane_id` back to its issue. */
  list: () => Promise<AgentRow[]>;
  /** Drop-in replacement for the `read` handed to `watchSessionLimits` — returns the SAME text unchanged, after teeing it through `detectSessionLimitRefusal` for the row that owns this `pane_id`. */
  read: (paneId: string) => Promise<string>;
}

export function createQuotaGate(list: () => Promise<AgentRow[]>, read: (paneId: string) => Promise<string>, now: () => number): QuotaGate {
  const blocked = new Map<string, boolean>();
  let lastRows: AgentRow[] = [];
  return {
    isBlocked: (issue) => blocked.get(issue) ?? false,
    list: async () => {
      lastRows = await list();
      return lastRows;
    },
    read: async (paneId) => {
      const text = await read(paneId);
      const row = lastRows.find((r) => r.pane_id === paneId);
      if (row?.issue) {
        const refusal = detectSessionLimitRefusal(text, new Date(now()));
        if (refusal) blocked.set(row.issue, true);
        else blocked.delete(row.issue);
      }
      return text;
    },
  };
}
