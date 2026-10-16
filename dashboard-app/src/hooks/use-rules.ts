/**
 * FACTORY-661: typed polling hook over a `RulesApi.listRules` — same
 * `usePolling`/cadence discipline `use-config-inventory.ts` already
 * follows. Takes the `RulesApi` as a parameter (rather than importing the
 * flag-selected `rulesApi` singleton itself) so a test can hand it
 * `createFixturesRulesApi({...})` directly instead of stubbing
 * `globalThis.fetch` for an in-memory implementation that never calls
 * `fetch` at all.
 */
import { useMemo } from "react";
import type { RulesApi, RulesListResponse } from "../api/rules.js";
import { DASHBOARD_POLL_INTERVAL_MS } from "./use-dashboard.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export function useRules(api: RulesApi): PollState<RulesListResponse> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => api.listRules(signal), [api]);
  return usePolling({ fetchOnce, intervalMs: DASHBOARD_POLL_INTERVAL_MS });
}
