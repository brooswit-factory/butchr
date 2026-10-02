/**
 * FACTORY-614: the thin, DOM-requiring half of polling — real timers and a
 * real `AbortController` driving the pure reducer in
 * `view-model/poll-state.ts`. Kept deliberately small (no branch here
 * decides a STATE, only whether/when to call `reducePollState`) so the
 * logic worth getting right lives in the part that's testable without a
 * DOM; `test/unit/dashboard-app-use-polling.test.tsx` only has to prove
 * this wiring, not re-prove the reducer's own transitions.
 */
import { useEffect, useRef, useState } from "react";
import { initialPollState, nextBackoffMs, reducePollState, type PollState } from "../view-model/poll-state.js";

export interface UsePollingOptions<T> {
  /** One fetch attempt; must respect `signal` (aborted on unmount). */
  fetchOnce: (signal: AbortSignal) => Promise<T>;
  /** Delay between a SUCCESSFUL poll and the next one. */
  intervalMs: number;
  /** First retry delay after a failure; doubles each consecutive failure, capped at `backoffMaxMs`. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function usePolling<T>(opts: UsePollingOptions<T>): PollState<T> {
  const [state, setState] = useState<PollState<T>>(initialPollState);
  const { fetchOnce, intervalMs, backoffBaseMs = DEFAULT_BACKOFF_BASE_MS, backoffMaxMs = DEFAULT_BACKOFF_MAX_MS, now = Date.now } = opts;
  // Stashed in a ref so the effect below never has to depend on it: a new
  // `fetchOnce` identity from the caller re-renders this hook without
  // tearing down and restarting the whole poll/backoff cycle mid-flight.
  const fetchOnceRef = useRef(fetchOnce);
  fetchOnceRef.current = fetchOnce;

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const scheduleNext = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(run, delay);
    };

    async function run() {
      try {
        const data = await fetchOnceRef.current(controller.signal);
        if (cancelled) return;
        consecutiveFailures = 0;
        setState((prev) => reducePollState(prev, { type: "success", data, now: now() }));
        scheduleNext(intervalMs);
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        setState((prev) => reducePollState(prev, { type: "failure", error: errorMessage(e) }));
        scheduleNext(nextBackoffMs(consecutiveFailures, backoffBaseMs, backoffMaxMs));
        consecutiveFailures += 1;
      }
    }

    run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchOnce is read via fetchOnceRef, deliberately not a dep (see comment above)
  }, [intervalMs, backoffBaseMs, backoffMaxMs, now]);

  return state;
}
