/**
 * own-writes.ts — an in-memory ledger of writes the daemon performed on Jira
 * tickets, so the notify loop (src/daemon/loop.ts) can tell a self-write
 * apart from a genuine third-party change without guessing. Pure: no timers,
 * no I/O — callers do the reading/writing to Jira and feed this module the
 * results.
 *
 * DISCRIMINATOR: exact `updated` match, not "swallow one bump". After a
 * write completes, the caller reads the ticket's `updated` field back and
 * records it as the expected value for (key, writer). A later poll suppresses
 * a ping ONLY when the polled `updated` equals a recorded expected value for
 * that key — anything newer means something else also happened, so it is
 * delivered. This makes "never lose a genuine change" mechanical: a
 * self-write plus a foreign comment inside one poll window push `updated`
 * strictly past the recorded value, so the newer value matches nothing, and
 * the ping goes out by construction, not by heuristic.
 *
 * WHO IS SUPPRESSED depends on the writer:
 * - An agent's own issue key (its `x-issue`) writing a ticket suppresses the
 *   ping to THAT AGENT ONLY. Every other watcher (e.g. its boss, through the
 *   Implements chain) still hears it — a task's "merged, over to you"
 *   comment on its own ticket is exactly how its story hears it; suppressing
 *   it for watchers would silence the whole command chain.
 * - The daemon itself (label sync; sentinel writer `"daemon"`) suppresses
 *   the ping for EVERY watcher of the bumped ticket, including its own
 *   agent — nobody is meant to hear a daemon label sync.
 *
 * Entries are NOT consumed on first match: several watchers of the same
 * ticket independently consult the same entry within one poll. An entry is
 * dropped once EITHER: it has aged past the TTL (default a few minutes —
 * long enough to cover one write + one read-back + one poll cycle, short
 * enough that a failed read-back does not leak forever), OR a poll observes
 * an `updated` value strictly newer than it — that value can never be
 * recorded retroactively, so an older entry can never match again and is
 * pruned as superseded.
 *
 * ACCEPTED, DOCUMENTED RACE: a foreign write landing between our write and
 * our read-back gets folded into the recorded expected value and is
 * suppressed once. The window is a single round-trip, and the next real
 * change still notifies normally.
 */

/** The sentinel writer for the daemon's own (non-agent) writes, e.g. label sync. */
export const DAEMON_WRITER = "daemon";

/** A few minutes: long enough for one write + read-back + poll cycle, short enough not to leak. */
export const DEFAULT_TTL_MS = 5 * 60_000;

interface Entry {
  expectedUpdated: string;
  writer: string;
  at: number;
}

export interface OwnWriteLedger {
  /** Record that `writer` performed a write on `key` expected to bump `updated` to `expectedUpdated`, observed `at`. */
  record(key: string, expectedUpdated: string, writer: string, at: number): void;
  /** Whether a ping to `watcher` about `key` (now at `updated`) should be swallowed as an echo of a recorded write. */
  shouldSuppress(key: string, updated: string, watcher: string, now: number): boolean;
  /** Drop every entry older than the TTL, regardless of whether it has been consulted. */
  prune(now: number): void;
}

/** A fresh, empty ledger. `ttlMs` overrides the default TTL — mainly for deterministic tests. */
export function createOwnWriteLedger(ttlMs: number = DEFAULT_TTL_MS): OwnWriteLedger {
  const byKey = new Map<string, Entry[]>();

  const isLive = (e: Entry, now: number, updated: string) =>
    now - e.at <= ttlMs && e.expectedUpdated >= updated;

  return {
    record(key, expectedUpdated, writer, at) {
      const list = byKey.get(key) ?? [];
      list.push({ expectedUpdated, writer, at });
      byKey.set(key, list);
    },

    shouldSuppress(key, updated, watcher, now) {
      const list = byKey.get(key);
      if (!list) return false;
      // TTL expiry and supersede-pruning happen together: an entry older
      // than `updated` (lexicographically, ISO-8601 sorts chronologically)
      // will never be observed again — Jira's `updated` only moves forward —
      // so it is dropped here rather than left to leak.
      const live = list.filter((e) => isLive(e, now, updated));
      if (live.length) byKey.set(key, live);
      else byKey.delete(key);
      return live.some((e) => e.expectedUpdated === updated && (e.writer === DAEMON_WRITER || e.writer === watcher));
    },

    prune(now) {
      for (const [key, list] of byKey) {
        const live = list.filter((e) => now - e.at <= ttlMs);
        if (live.length) byKey.set(key, live);
        else byKey.delete(key);
      }
    },
  };
}
