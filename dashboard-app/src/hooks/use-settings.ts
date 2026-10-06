/**
 * FACTORY-664 — typed polling hook over `SettingsApi.listSettings`, same
 * `usePolling`/cadence discipline `use-rules.ts` already follows.
 */
import { useMemo } from "react";
import type { SettingsApi, SettingsResponse } from "../api/settings.js";
import { DASHBOARD_POLL_INTERVAL_MS } from "./use-dashboard.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export function useSettings(api: SettingsApi): PollState<SettingsResponse> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => api.listSettings(signal), [api]);
  return usePolling({ fetchOnce, intervalMs: DASHBOARD_POLL_INTERVAL_MS });
}
