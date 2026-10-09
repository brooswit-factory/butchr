/**
 * FACTORY-962 (epic FACTORY-659, slice D1 follow-up) — typed polling hook
 * for the new `GET /api/links` endpoint, same "one fetcher, `usePolling`
 * owns the cadence/retry/stale logic" shape `useConfigInventory` already
 * establishes — no new polling machinery invented here.
 */
import { useMemo } from "react";
import { DASHBOARD_POLL_INTERVAL_MS } from "./use-dashboard.js";
import { fetchJson } from "./fetch-json.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export interface LinksResponse {
  links: Array<{ owner: string; targets: string[] }>;
}

export function useLinks(): PollState<LinksResponse> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => fetchJson<LinksResponse>("/api/links", signal), []);
  return usePolling({ fetchOnce, intervalMs: DASHBOARD_POLL_INTERVAL_MS });
}
