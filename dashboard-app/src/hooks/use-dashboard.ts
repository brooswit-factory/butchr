/**
 * FACTORY-614: typed polling hook for the EXISTING `GET /dashboard` JSON
 * endpoint (`src/web/view.ts`, backed by `src/agents/dashboard.ts`) — no new
 * server API. Cadence matches the current server-rendered page's own
 * refresh: `src/web/dashboard-page.ts`'s `renderDashboard` defaults
 * `refreshSeconds` to 5, and `src/web/view.ts` never overrides it, so 5000ms
 * here is that same real cadence, not a guess.
 */
import { useMemo } from "react";
import type { DashboardResponse } from "../../../src/agents/dashboard.js";
import { fetchJson } from "./fetch-json.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export const DASHBOARD_POLL_INTERVAL_MS = 5000;

export function useDashboard(): PollState<DashboardResponse> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => fetchJson<DashboardResponse>("/dashboard", signal), []);
  return usePolling({ fetchOnce, intervalMs: DASHBOARD_POLL_INTERVAL_MS });
}
