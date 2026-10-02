/**
 * FACTORY-614: typed polling hook for the EXISTING `GET /config-inventory`
 * JSON endpoint (`src/web/view.ts`, backed by
 * `src/agents/query-agent-inventory.ts`) — no new server API. This
 * response has no live/withheld distinction of its own to poll faster or
 * slower for, so it reuses the SAME cadence `/dashboard` already polls at
 * (`use-dashboard.ts`'s `DASHBOARD_POLL_INTERVAL_MS`) rather than inventing
 * a second number — one less thing for a reader of both hooks to reconcile.
 */
import { useMemo } from "react";
import type { QueryAgentInventory } from "../../../src/agents/query-agent-inventory.js";
import { DASHBOARD_POLL_INTERVAL_MS } from "./use-dashboard.js";
import { fetchJson } from "./fetch-json.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export function useConfigInventory(): PollState<QueryAgentInventory> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => fetchJson<QueryAgentInventory>("/config-inventory", signal), []);
  return usePolling({ fetchOnce, intervalMs: DASHBOARD_POLL_INTERVAL_MS });
}
