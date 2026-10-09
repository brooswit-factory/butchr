/**
 * FACTORY-668 (epic FACTORY-659, slices C1 read / C2 write) — the daemon
 * health/logs page's own client module. `fetchLogs` hits the new
 * `GET /api/daemon/logs` (guarded the same as `GET /api/rules` — no CSRF
 * needed, it's a GET). `reload` hits the new `POST /api/daemon/reload`
 * (full write-guard chain, same CSRF dance `writeSetting`/`restartDaemon`
 * already use — reuses `fetchCsrfToken`/`errorMessageOf`/
 * `retryAfterSecondsOf`/`CSRF_HEADER` from `./settings.js` rather than a
 * second copy of that glue). Restart itself is NOT re-implemented here —
 * the page reuses `SettingsApi.restartDaemon` and `DaemonRestartControl`
 * directly, per the ticket's own "reuse it, don't build another" instruction.
 */
import { CSRF_HEADER, fetchCsrfToken, errorMessageOf, retryAfterSecondsOf, RateLimitError } from "./settings.js";

export interface DaemonLogsResponse {
  source: string;
  unit: string;
  lines: string[];
  truncated: boolean;
}

/** Thrown by `fetchLogs` when the log source itself is unavailable (no systemd unit/task detected, or the log read failed) — the route's own 503, surfaced verbatim so the UI can show the operator-actionable message rather than a generic failure. */
export class DaemonLogsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLogsUnavailableError";
  }
}

export interface DaemonReloadResult {
  ok: boolean;
  path: string;
  added: string[];
  removed: string[];
  changed: string[];
  problems: string[];
}

/** Thrown by `reload` on a 409 (rules.json failed to parse/validate) — `result.problems` is the exact list `loadRules` produced. */
export class DaemonReloadFailedError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[]) {
    super(message);
    this.name = "DaemonReloadFailedError";
    this.problems = problems;
  }
}

export interface DaemonApi {
  fetchLogs(signal?: AbortSignal): Promise<DaemonLogsResponse>;
  reload(signal?: AbortSignal): Promise<DaemonReloadResult>;
}

export const realDaemonApi: DaemonApi = {
  async fetchLogs(signal) {
    const res = await fetch("/api/daemon/logs", signal ? { signal } : {});
    if (!res.ok) {
      const message = await errorMessageOf(res, "/api/daemon/logs");
      throw new DaemonLogsUnavailableError(message);
    }
    return (await res.json()) as DaemonLogsResponse;
  },
  async reload(signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch("/api/daemon/reload", {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: JSON.stringify({}),
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<DaemonReloadResult> & { error?: string };
    if (!res.ok) {
      const message = body.error ?? `/api/daemon/reload: HTTP ${res.status}`;
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      throw new DaemonReloadFailedError(message, body.problems ?? []);
    }
    return body as DaemonReloadResult;
  },
};

export interface FixturesDaemonApiOptions {
  logs?: DaemonLogsResponse;
  nextLogsError?: DaemonLogsUnavailableError;
  nextReloadResult?: DaemonReloadResult;
  nextReloadError?: DaemonReloadFailedError | RateLimitError;
  latencyMs?: number;
}

export function defaultDaemonLogsFixture(): DaemonLogsResponse {
  return { source: "journalctl --user -u butchr.service", unit: "butchr.service", lines: ["butchr daemon on http://127.0.0.1:7717", "butchr: rules reloaded from /x/rules.json: 2 enabled"], truncated: false };
}

export function createFixturesDaemonApi(opts: FixturesDaemonApiOptions = {}): DaemonApi {
  let nextLogsError = opts.nextLogsError;
  let nextReloadResult = opts.nextReloadResult;
  let nextReloadError = opts.nextReloadError;
  const logs = opts.logs ?? defaultDaemonLogsFixture();
  const latencyMs = opts.latencyMs ?? 0;
  return {
    async fetchLogs() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextLogsError) { const e = nextLogsError; nextLogsError = undefined; throw e; }
      return logs;
    },
    async reload() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextReloadError) { const e = nextReloadError; nextReloadError = undefined; throw e; }
      const result = nextReloadResult ?? { ok: true, path: "/x/rules.json", added: [], removed: [], changed: [], problems: [] };
      nextReloadResult = undefined;
      return result;
    },
  };
}
