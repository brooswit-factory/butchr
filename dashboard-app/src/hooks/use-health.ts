/**
 * FACTORY-615: typed polling hook for the EXISTING `GET /health` JSON
 * endpoint (`src/web/view.ts`) — no new server API. This is the SAME
 * synchronous `build`/`currency` sibling info `src/web/dashboard-page.ts`'s
 * `renderBuildHeader` already reads (that module's own header comment);
 * `/dashboard`'s own response carries neither field, so the real dashboard
 * page polls `/health` separately, at the same cadence, for its header line.
 */
import { useMemo } from "react";
import type { HealthStatus } from "../../../src/daemon/health.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export const HEALTH_POLL_INTERVAL_MS = 5000;

/**
 * Deliberately NOT `fetchJson` (`./fetch-json.js`): that helper treats any
 * non-2xx as a transport failure, but `/health` returns `503` with a FULLY
 * VALID body the instant any component goes unhealthy (`src/web/view.ts`'s
 * own `set.status = 503` on `!status.ok`) — the build/currency header this
 * hook exists to feed must keep showing on an otherwise-unhealthy daemon,
 * exactly as it always has when `src/web/dashboard-page.ts` read the same
 * fields in-process. Only a genuine network/parse failure should move this
 * hook's state to `error`/`stale`.
 */
async function fetchHealth(signal: AbortSignal): Promise<HealthStatus> {
  const res = await fetch("/health", { signal });
  return (await res.json()) as HealthStatus;
}

export function useHealth(): PollState<HealthStatus> {
  const fetchOnce = useMemo(() => fetchHealth, []);
  return usePolling({ fetchOnce, intervalMs: HEALTH_POLL_INTERVAL_MS });
}
