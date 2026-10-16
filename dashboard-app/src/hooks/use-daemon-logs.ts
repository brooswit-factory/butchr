/**
 * FACTORY-668 (C1, read) — typed polling hook for `GET /api/daemon/logs`,
 * same shape as `./use-health.ts`'s `useHealth`: a thin `usePolling` wrapper
 * over the daemon API's own `fetchLogs`.
 */
import { useMemo } from "react";
import { realDaemonApi, type DaemonApi, type DaemonLogsResponse } from "../api/daemon.js";
import { usePolling } from "./use-polling.js";
import type { PollState } from "../view-model/poll-state.js";

export const DAEMON_LOGS_POLL_INTERVAL_MS = 5000;

export function useDaemonLogs(api: DaemonApi = realDaemonApi): PollState<DaemonLogsResponse> {
  const fetchOnce = useMemo(() => (signal: AbortSignal) => api.fetchLogs(signal), [api]);
  return usePolling({ fetchOnce, intervalMs: DAEMON_LOGS_POLL_INTERVAL_MS });
}
