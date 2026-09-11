/**
 * BUTCHR-269: derives "how long has this agent been in its current
 * agent_status" — a field herdr does not supply (`AgentInfo` carries no
 * timestamp; `state_change_seq`/`revision` are monotonic counters, not
 * clocks) and that neither existing tracker can be widened to answer:
 * `StalledTracker` (src/agents/stalled.ts) is idle-only and latches
 * `streakBroken` permanently on the first non-idle observation; the
 * frozen-asleep tracker (src/agents/frozen-asleep.ts) tracks a different
 * question (resting-AND-running, not a status floor). Both are load-bearing
 * for their own detectors, so this is a THIRD, dedicated tracker rather than
 * a widening of either.
 *
 * THE VALUE IS A FLOOR, NOT AN ELAPSED TIME: this tracker is in-memory only,
 * so a daemon restart starts every entry's floor fresh from the restart, not
 * from whenever the status genuinely began. That is safe in the same sense
 * StalledTracker/FrozenAsleepTracker's own restart loss is safe — it can only
 * ever DELAY how large the reported number looks, never fabricate one that's
 * too large — but the caller must not read the number alone as "the agent
 * has been in this status for exactly this long"; see `exact` below.
 */

/** One id's current status floor, with the provenance the caller needs to render it honestly. */
export interface StatusFloor {
  /** Epoch ms this tracker's floor for the CURRENT status started. */
  sinceMs: number;
  /** `sinceMs` as an ISO timestamp — the machine-readable half of the pair the ticket asks for. */
  since: string;
  /** A human-readable rendering of `now - sinceMs` (e.g. "6d 3h 12m") — the glanceable half; a caller must not have to do epoch arithmetic to notice a multi-day floor. */
  humanDuration: string;
  /**
   * `true` when THIS tracker personally observed the transition into the
   * current status (a prior `observe()` call for this id recorded a
   * DIFFERENT status) — `sinceMs` is then the genuine, exact start.
   * `false` means the floor is only a lower bound: the id's first-ever
   * `observe()` call (a fresh instance, or a daemon restart, or an agent this
   * tracker has never seen before) — the status could genuinely have started
   * any time before `sinceMs`, including well before this process existed.
   * Never inferred from the numeric value alone (a fresh floor can equal an
   * exact one at `now - sinceMs === 0`) — this is the flag a caller must
   * check instead of assuming a small number means "just started".
   */
  exact: boolean;
}

interface Entry {
  status: string;
  sinceMs: number;
  exact: boolean;
}

/**
 * Per-id in-memory "time in current status" floor. One `observe()` call per
 * id per poll — same shape as `StalledTracker`/`FrozenAsleepTracker`: a plain
 * `Map`, an injected `now`, no I/O, no persistence.
 */
export class StatusFloorTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /** Record this poll's observed `status` for `id`, returning its current floor. */
  observe(id: string, status: string): StatusFloor {
    const existing = this.entries.get(id);
    let entry: Entry;
    if (!existing) {
      // First time this tracker has ever seen `id` — no basis to say when
      // `status` truly began, so the floor starts now and is marked inexact.
      entry = { status, sinceMs: this.now(), exact: false };
      this.entries.set(id, entry);
    } else if (existing.status !== status) {
      // A genuine, personally-observed transition: the floor resets AND
      // becomes exact — this tracker was watching at the moment it changed.
      entry = { status, sinceMs: this.now(), exact: true };
      this.entries.set(id, entry);
    } else {
      // Status held since the last observation — neither the floor's start
      // time nor its exactness changes.
      entry = existing;
    }
    return toFloor(entry, this.now());
  }

  /** Drop tracking for every id not in `stillPresent` — a later reappearance starts a fresh, inexact floor rather than inheriting a stale one. */
  forgetMissing(stillPresent: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!stillPresent.has(id)) this.entries.delete(id);
  }
}

function toFloor(entry: Entry, now: number): StatusFloor {
  return {
    sinceMs: entry.sinceMs,
    since: new Date(entry.sinceMs).toISOString(),
    humanDuration: humanDuration(now - entry.sinceMs),
    exact: entry.exact,
  };
}

/** Renders a millisecond duration as a compact, glanceable string — "6d 3h 12m", "42m 3s", "0s". Never a bare number: the whole point of this field is that a reader shouldn't have to do arithmetic on an epoch to notice a multi-day floor. */
export function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  if (!days && !hours && !minutes) parts.push(`${seconds}s`);
  return parts.join(" ");
}
