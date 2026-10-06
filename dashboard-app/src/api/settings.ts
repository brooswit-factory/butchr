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
  | { key: string; value: string | null; source: "environment" | "default"; restartNeeded: true; secret: false; description: string }
  | { key: string; set: boolean; source: "environment" | "default"; restartNeeded: true; secret: true; description: string };

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

export interface SettingsApi {
  listSettings(signal?: AbortSignal): Promise<SettingsResponse>;
  testJiraConnection(signal?: AbortSignal): Promise<JiraTestResult>;
}

const CSRF_HEADER = "x-butchr-csrf";

async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
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
      let message = `/api/settings/jira/test: HTTP ${res.status}`;
      try {
        const body: unknown = await res.json();
        if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") message = (body as { error: string }).error;
      } catch { /* non-JSON error body: keep the generic message */ }
      if (res.status === 429) {
        const header = res.headers.get("retry-after");
        const parsed = header !== null ? Number.parseInt(header, 10) : NaN;
        throw new RateLimitError(message, Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined);
      }
      throw new Error(message);
    }
    return (await res.json()) as JiraTestResult;
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
      { key: "ATLASSIAN_SITE", value: "https://example.atlassian.net", source: "environment", restartNeeded: true, secret: false, description: "The Atlassian site base URL this daemon reads and writes." },
      { key: "ATLASSIAN_EMAIL", value: "butchr@example.com", source: "environment", restartNeeded: true, secret: false, description: "The Atlassian account email used for basic-auth API calls." },
      { key: "ATLASSIAN_TOKEN", set: true, source: "environment", restartNeeded: true, secret: true, description: "The Atlassian API token, used directly." },
      { key: "BUTCHR_PORT", value: "7717", source: "environment", restartNeeded: true, secret: false, description: "The TCP port this daemon's MCP endpoint and dashboard listen on." },
      { key: "BUTCHR_MAX_AGENTS", value: null, source: "default", restartNeeded: true, secret: false, description: "Fixed cap on agents this daemon keeps resident at once." },
      { key: "BUTCHR_AGENT_PROVIDER", value: "claude", source: "environment", restartNeeded: true, secret: false, description: "Default agent provider used when no per-role override is set." },
      { key: "GITHUB_TOKEN_FILE", set: false, source: "default", restartNeeded: true, secret: true, description: "Path to a file holding the GitHub token." },
    ],
    atlassianTokenFile: { key: "ATLASSIAN_TOKEN_FILE", path: "/home/butchr/.config/butchr/atlassian-token", source: "environment", restartNeeded: true, secret: false, description: DEFAULT_DESCRIPTION, exists: true, readable: true, mode: 0o600, tooOpen: false },
    unitHint: { dropInPaths: [], environmentFiles: ["/home/butchr/.config/butchr/butchr.env"] },
  };
}

export function createFixturesSettingsApi(opts: FixturesSettingsApiOptions = {}): SettingsApi {
  let nextJiraTest = opts.nextJiraTest;
  let nextRateLimit = opts.nextRateLimit;
  const latencyMs = opts.latencyMs ?? 0;
  const response = opts.response ?? defaultSettingsFixture();
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
  };
}
