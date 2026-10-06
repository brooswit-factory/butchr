/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — the ONE client
 * module the Settings page talks to. Shapes read off the real server
 * (`src/web/settings-api.ts`, `src/web/jira-connection-test.ts`), never
 * invented. Same "two implementations behind one interface" pattern as
 * `api/rules.ts`: `realSettingsApi` hits the real endpoints; a fixtures
 * implementation (`createFixturesSettingsApi`) lets tests/dev rehearse
 * every state (unset, set, file missing, too open, test ok/401/network,
 * rate-limited) with no network at all.
 */

export type SettingEntry =
  | { key: string; value: string | null; source: "environment" | "file" | "default"; restartNeeded: true; secret: false; editable: boolean; description: string }
  | { key: string; set: boolean; source: "environment" | "file" | "default"; restartNeeded: true; secret: true; editable: boolean; description: string };

export interface AtlassianTokenFileStatus {
  key: "ATLASSIAN_TOKEN_FILE";
  path: string | null;
  source: "environment" | "default";
  restartNeeded: true;
  secret: false;
  description: string;
  exists: boolean;
  readable: boolean;
  mode: number | null;
  tooOpen: boolean | null;
}

export interface UnitHint {
  dropInPaths: string[];
  environmentFiles: string[];
}

export interface SettingsResponse {
  settings: SettingEntry[];
  atlassianTokenFile: AtlassianTokenFileStatus;
  unitHint?: UnitHint;
}

export type HttpStatusClass = "2xx" | "401/403" | "other" | "network";

export interface JiraTestResult {
  ok: boolean;
  site: string;
  httpStatusClass: HttpStatusClass;
  error?: string;
}

/** Thrown by `testJiraConnection` for a 429 (the route's own 1-per-5s limit) — same shape/discipline as `api/rules.ts`'s `RateLimitError`. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds: number | undefined) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** FACTORY-665 — thrown by `writeSetting` for a 400 refusal (invalid value, or a ceiling/floor crossing that needs `confirm: true`). `needsConfirm` is `true` only for the latter — the UI uses it to decide whether to re-offer the write with a confirm dialog rather than just showing the error. */
export class SettingsWriteRefusedError extends Error {
  readonly needsConfirm: boolean;
  constructor(message: string, needsConfirm: boolean) {
    super(message);
    this.name = "SettingsWriteRefusedError";
    this.needsConfirm = needsConfirm;
  }
}

/** FACTORY-665 — `POST /api/daemon/restart`'s 409 refusal ("restart butchr manually" — not running under systemd). */
export class DaemonRestartUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonRestartUnavailableError";
  }
}

export interface SettingsApi {
  listSettings(signal?: AbortSignal): Promise<SettingsResponse>;
  testJiraConnection(signal?: AbortSignal): Promise<JiraTestResult>;
  /** FACTORY-665 — writes one allowlisted key, returning the fresh `SettingsResponse` on success. Throws `SettingsWriteRefusedError` (400) or `RateLimitError` (429, shared write-flood budget). */
  writeSetting(key: string, value: string, confirm: boolean, signal?: AbortSignal): Promise<SettingsResponse>;
  /** FACTORY-665 — fires a daemon restart (requires the caller to have already confirmed). Throws `DaemonRestartUnavailableError` (409) or `RateLimitError` (429, 1-per-10-minutes budget). Resolves on a 200 — the caller should expect the connection to drop shortly after. */
  restartDaemon(signal?: AbortSignal): Promise<void>;
}

const CSRF_HEADER = "x-butchr-csrf";

async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/** `res.json().error`, or a generic `<label>: HTTP <status>` when the body isn't the expected `{error: string}` shape (a non-JSON or malformed error body). */
async function errorMessageOf(res: Response, label: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
  } catch { /* non-JSON error body: fall through to the generic message */ }
  return `${label}: HTTP ${res.status}`;
}

/** `Retry-After` as a finite non-negative integer, or `undefined` when absent/malformed. */
function retryAfterSecondsOf(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  const parsed = header !== null ? Number.parseInt(header, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export const realSettingsApi: SettingsApi = {
  async listSettings(signal) {
    const res = await fetch("/api/settings", signal ? { signal } : {});
    if (!res.ok) throw new Error(`/api/settings: HTTP ${res.status}`);
    return (await res.json()) as SettingsResponse;
  },
  async testJiraConnection(signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch("/api/settings/jira/test", {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, "/api/settings/jira/test");
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      throw new Error(message);
    }
    return (await res.json()) as JiraTestResult;
  },
  async writeSetting(key, value, confirm, signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: JSON.stringify({ value, confirm }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, `PUT /api/settings/${key}`);
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      if (res.status === 400) throw new SettingsWriteRefusedError(message, /retry with confirm: true/.test(message));
      throw new Error(message);
    }
    return (await res.json()) as SettingsResponse;
  },
  async restartDaemon(signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch("/api/daemon/restart", {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: JSON.stringify({ confirm: true }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, "/api/daemon/restart");
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      if (res.status === 409) throw new DaemonRestartUnavailableError(message);
      throw new Error(message);
    }
  },
};

export interface FixturesSettingsApiOptions {
  response?: SettingsResponse;
  /** One-shot: consumed by the next `testJiraConnection` call, then cleared. Defaults to a 2xx `ok: true` result. */
  nextJiraTest?: JiraTestResult;
  /** One-shot rate-limit simulation for `testJiraConnection`. */
  nextRateLimit?: { retryAfterSeconds?: number };
  latencyMs?: number;
}

const DEFAULT_DESCRIPTION = "x";

export function defaultSettingsFixture(): SettingsResponse {
  return {
    settings: [
      { key: "ATLASSIAN_SITE", value: "https://example.atlassian.net", source: "environment", restartNeeded: true, secret: false, editable: false, description: "The Atlassian site base URL this daemon reads and writes." },
      { key: "ATLASSIAN_EMAIL", value: "butchr@example.com", source: "environment", restartNeeded: true, secret: false, editable: false, description: "The Atlassian account email used for basic-auth API calls." },
      { key: "ATLASSIAN_TOKEN", set: true, source: "environment", restartNeeded: true, secret: true, editable: false, description: "The Atlassian API token, used directly." },
      { key: "BUTCHR_PORT", value: "7717", source: "environment", restartNeeded: true, secret: false, editable: false, description: "The TCP port this daemon's MCP endpoint and dashboard listen on." },
      { key: "BUTCHR_MAX_AGENTS", value: null, source: "default", restartNeeded: true, secret: false, editable: true, description: "Fixed cap on agents this daemon keeps resident at once." },
      { key: "BUTCHR_AGENT_PROVIDER", value: "claude", source: "environment", restartNeeded: true, secret: false, editable: true, description: "Default agent provider used when no per-role override is set." },
      { key: "BUTCHR_POLL_STALE_MS", value: "60000", source: "file", restartNeeded: true, secret: false, editable: true, description: "Milliseconds /health tolerates the poll loop going without a completed cycle before reporting stale." },
      { key: "GITHUB_TOKEN_FILE", set: false, source: "default", restartNeeded: true, secret: true, editable: false, description: "Path to a file holding the GitHub token." },
    ],
    atlassianTokenFile: { key: "ATLASSIAN_TOKEN_FILE", path: "/home/butchr/.config/butchr/atlassian-token", source: "environment", restartNeeded: true, secret: false, description: DEFAULT_DESCRIPTION, exists: true, readable: true, mode: 0o600, tooOpen: false },
    unitHint: { dropInPaths: [], environmentFiles: ["/home/butchr/.config/butchr/butchr.env"] },
  };
}

export interface FixturesSettingsApiOptionsExtra {
  /** One-shot: thrown by the next `writeSetting` call, then cleared. */
  nextWriteError?: SettingsWriteRefusedError;
  /** One-shot: thrown by the next `restartDaemon` call, then cleared. */
  nextRestartError?: DaemonRestartUnavailableError;
}

export function createFixturesSettingsApi(opts: FixturesSettingsApiOptions & FixturesSettingsApiOptionsExtra = {}): SettingsApi {
  let nextJiraTest = opts.nextJiraTest;
  let nextRateLimit = opts.nextRateLimit;
  let nextWriteError = opts.nextWriteError;
  let nextRestartError = opts.nextRestartError;
  let response = opts.response ?? defaultSettingsFixture();
  const latencyMs = opts.latencyMs ?? 0;
  return {
    async listSettings() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return response;
    },
    async testJiraConnection() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextRateLimit) {
        const retryAfterSeconds = nextRateLimit.retryAfterSeconds;
        nextRateLimit = undefined;
        throw new RateLimitError("rate limited: too many jira connection tests", retryAfterSeconds);
      }
      const result = nextJiraTest ?? { ok: true, site: "https://example.atlassian.net", httpStatusClass: "2xx" as const };
      nextJiraTest = undefined;
      return result;
    },
    async writeSetting(key, value) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextWriteError) {
        const err = nextWriteError;
        nextWriteError = undefined;
        throw err;
      }
      response = { ...response, settings: response.settings.map((e) => (e.key === key && !e.secret ? { ...e, value, source: "file" as const } : e)) };
      return response;
    },
    async restartDaemon() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextRestartError) {
        const err = nextRestartError;
        nextRestartError = undefined;
        throw err;
      }
    },
  };
}
