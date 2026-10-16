/**
 * FACTORY-614: the TRANSPORT-level state for a polled endpoint — distinct
 * from, and never conflated with, the payload's own internal
 * "could not check" semantics (`src/agents/dashboard.ts`'s `checked`/
 * `declinedAt`): this module only knows whether OUR fetch of the endpoint
 * is succeeding, not whether the daemon's own last poll of ITS sources
 * succeeded. A `DashboardResponse` can be `checked: false` while this
 * module's own state is `loaded` (our fetch worked fine; the daemon is
 * the one reporting trouble) — see `view-model/dashboard-availability.ts`
 * for that payload-level distinction.
 *
 * Plain TypeScript, no React, no DOM, no timers — `reducePollState` is a
 * pure reducer so the hook (`hooks/use-polling.ts`) that drives real
 * fetches/timers around it stays a thin wrapper, and every state
 * transition is unit-testable without a DOM.
 */
export type PollState<T> =
  | { kind: "loading" }
  | { kind: "loaded"; data: T; confirmedAt: number }
  | { kind: "stale"; data: T; confirmedAt: number; error: string }
  | { kind: "error"; error: string };

export type PollEvent<T> = { type: "success"; data: T; now: number } | { type: "failure"; error: string };

/**
 * `success` always wins and clears any prior error. `failure` on top of a
 * `loaded`/`stale` state keeps the LAST GOOD `data`/`confirmedAt` (never
 * discards it, never re-stamps it) and moves to `stale` — a refresh
 * failing is reported ALONGSIDE the last good data, not instead of it.
 * `failure` with no prior data (still `loading`, or already `error`) moves
 * to (or stays at) plain `error`: there is no last good data to show
 * stale.
 */
export function reducePollState<T>(prev: PollState<T>, event: PollEvent<T>): PollState<T> {
  if (event.type === "success") return { kind: "loaded", data: event.data, confirmedAt: event.now };
  if (prev.kind === "loaded" || prev.kind === "stale") return { kind: "stale", data: prev.data, confirmedAt: prev.confirmedAt, error: event.error };
  return { kind: "error", error: event.error };
}

export const initialPollState: PollState<never> = { kind: "loading" };

/**
 * Exponential backoff after `consecutiveFailures` failures in a row (0 ==
 * the very first failure), capped at `maxMs`. Reused verbatim by the hook
 * so "how long to wait before retrying" is exactly as testable as every
 * other transition in this module, without a real timer in the loop.
 */
export function nextBackoffMs(consecutiveFailures: number, baseMs: number, maxMs: number): number {
  const delay = baseMs * 2 ** consecutiveFailures;
  return Math.min(delay, maxMs);
}
