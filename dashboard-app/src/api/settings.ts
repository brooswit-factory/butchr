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
  /** local/ui — the credential cards' data (`src/web/credentials-api.ts`). Absent from a butchr without them. */
  credentials?: CredentialsSummary;
}

/** local/ui — where a token lives: a literal in the env, a file the env names, butchr's own secrets file, or nowhere yet. */
export type CredentialSource = "env-literal" | "env-file" | "secrets-file" | "unset";

/** local/ui — mirrors `src/web/credentials-api.ts`'s `TokenStatus`: never a token value. */
export interface TokenStatus {
  source: CredentialSource;
  fileEnvKey: string;
  path: string | null;
  exists: boolean;
  readable: boolean;
  mode: number | null;
  tooOpen: boolean | null;
  readOnlyReason: string | null;
}

/** local/ui — a non-secret setting the env (which then wins) or settings.json can set. Mirrors `src/web/credentials-api.ts`'s `LayeredValue`. */
export interface LayeredValue {
  value: string | null;
  source: "environment" | "file" | "default";
  editable: boolean;
  /** What the running butchr started with; it keeps using that until a restart. */
  running: string | null;
}

/** local/ui — mirrors `src/web/credentials-api.ts`'s `CredentialsSummary`. */
export interface CredentialsSummary {
  atlassian: { site: string | null; email: string | null; token: TokenStatus };
  /** `runningOrgs`: what the running butchr started with; `orgs` is what's saved (the next start's). */
  github: { token: TokenStatus; orgs: string[]; orgsSource: "environment" | "file" | "default"; orgsEditable: boolean; active: boolean; runningOrgs: string[] };
  zendesk: { subdomain: LayeredValue; token: TokenStatus; riskAccepted: boolean };
  trello: { boardId: LayeredValue; apiKey: TokenStatus; token: TokenStatus; riskAccepted: boolean };
  setupCode: { command: string; findCommand: string | null; where: string };
  /** `startedAt`: when the running butchr started, so a restart's new process can be told apart. */
  restart: { supported: boolean; supervisor: "launchd" | "systemd" | "none"; startedAt: string };
}

/** local/ui — `POST /api/settings/{zendesk,trello}/test`'s result: the account butchr's saved credentials belong to (and, for Trello, the board's name). */
export interface ProviderTestResult {
  ok: boolean;
  account?: string;
  board?: string;
  error?: string;
}

/** local/ui — the success body of `PUT /api/settings/zendesk/token` and `PUT /api/settings/trello/credentials`. */
export interface ProviderSecretWriteOk {
  ok: true;
  account: string;
  rotated: boolean;
  restartNeeded: true;
}

/** local/ui — `POST /api/settings/github/test`'s result (`src/web/github-connection-test.ts`). */
export interface GithubTestResult {
  ok: boolean;
  login?: string;
  httpStatusClass: HttpStatusClass;
  error?: string;
  orgs: { org: string; ok: boolean; httpStatusClass: HttpStatusClass }[];
}

/** local/ui — `PUT /api/settings/github/token`'s success body. */
export interface GithubTokenWriteOk {
  ok: true;
  login: string;
  rotated: boolean;
  restartNeeded: true;
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
  /** local/ui — tests the daemon's loaded GitHub token. Throws `RateLimitError` (429). */
  testGithubConnection(signal?: AbortSignal): Promise<GithubTestResult>;
  /** local/ui — sets the GitHub token (one-time setup code required). Throws `RateLimitError` (429) or an `Error` carrying the server's own message. */
  writeGithubToken(input: { token: string; setupCode: string }, signal?: AbortSignal): Promise<GithubTokenWriteOk>;
  /** local/ui — tests the running butchr's Zendesk or Trello credentials. Throws `RateLimitError` (429). */
  testProviderConnection(provider: "zendesk" | "trello", signal?: AbortSignal): Promise<ProviderTestResult>;
  /** local/ui — sets the Zendesk OAuth token (setup code required). Same errors as `writeGithubToken`. */
  writeZendeskToken(input: { token: string; setupCode: string }, signal?: AbortSignal): Promise<ProviderSecretWriteOk>;
  /** local/ui — sets the Trello API key and token together (setup code required). Same errors as `writeGithubToken`. */
  writeTrelloCredentials(input: { apiKey: string; token: string; setupCode: string }, signal?: AbortSignal): Promise<ProviderSecretWriteOk>;
}

export const CSRF_HEADER = "x-butchr-csrf";

/** FACTORY-668 — exported so other API modules (`./daemon.js`) hit the SAME `/api/session` issuer rather than re-deriving a CSRF token fetch of their own. */
export async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/** `res.json().error`, or a generic `<label>: HTTP <status>` when the body isn't the expected `{error: string}` shape (a non-JSON or malformed error body). Exported for reuse (`./daemon.js`). */
export async function errorMessageOf(res: Response, label: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
  } catch { /* non-JSON error body: fall through to the generic message */ }
  return `${label}: HTTP ${res.status}`;
}

/** `Retry-After` as a finite non-negative integer, or `undefined` when absent/malformed. Exported for reuse (`./daemon.js`). */
export function retryAfterSecondsOf(res: Response): number | undefined {
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
  async testGithubConnection(signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch("/api/settings/github/test", {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, "/api/settings/github/test");
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      throw new Error(message);
    }
    return (await res.json()) as GithubTestResult;
  },
  async writeGithubToken(input, signal) {
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch("/api/settings/github/token", {
      method: "PUT",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, "/api/settings/github/token");
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      throw new Error(message);
    }
    return (await res.json()) as GithubTokenWriteOk;
  },
  async testProviderConnection(provider, signal) {
    const path = `/api/settings/${provider}/test`;
    const csrfToken = await fetchCsrfToken(signal);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const message = await errorMessageOf(res, path);
      if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
      throw new Error(message);
    }
    return (await res.json()) as ProviderTestResult;
  },
  async writeZendeskToken(input, signal) {
    return putProviderSecret("/api/settings/zendesk/token", input, signal);
  },
  async writeTrelloCredentials(input, signal) {
    return putProviderSecret("/api/settings/trello/credentials", input, signal);
  },
};

async function putProviderSecret(path: string, input: Record<string, string>, signal: AbortSignal | undefined): Promise<ProviderSecretWriteOk> {
  const csrfToken = await fetchCsrfToken(signal);
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const message = await errorMessageOf(res, path);
    if (res.status === 429) throw new RateLimitError(message, retryAfterSecondsOf(res));
    throw new Error(message);
  }
  return (await res.json()) as ProviderSecretWriteOk;
}

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
  /** local/ui — one-shot: the next `testGithubConnection` result. Defaults to a signed-in result covering the configured orgs. */
  nextGithubTest?: GithubTestResult;
  /** local/ui — one-shot: thrown by the next `writeGithubToken` call, then cleared. */
  nextGithubWriteError?: Error;
  /** local/ui — one-shot: the next `testProviderConnection` result. Defaults to a signed-in result. */
  nextProviderTest?: ProviderTestResult;
  /** local/ui — one-shot: thrown by the next `writeZendeskToken`/`writeTrelloCredentials` call, then cleared. */
  nextProviderWriteError?: Error;
}

/** A token the fixtures just "wrote": marked present at 0600, kept wherever it already lived. */
function writtenToken(token: TokenStatus): TokenStatus {
  return { ...token, source: token.source === "unset" ? "secrets-file" : token.source, exists: true, readable: true, mode: 0o600, tooOpen: false };
}

export function createFixturesSettingsApi(opts: FixturesSettingsApiOptions & FixturesSettingsApiOptionsExtra = {}): SettingsApi {
  let nextJiraTest = opts.nextJiraTest;
  let nextRateLimit = opts.nextRateLimit;
  let nextWriteError = opts.nextWriteError;
  let nextRestartError = opts.nextRestartError;
  let nextGithubTest = opts.nextGithubTest;
  let nextGithubWriteError = opts.nextGithubWriteError;
  let nextProviderTest = opts.nextProviderTest;
  let nextProviderWriteError = opts.nextProviderWriteError;
  let response = opts.response ?? defaultSettingsFixture();
  const takeProviderWriteError = () => {
    const err = nextProviderWriteError;
    nextProviderWriteError = undefined;
    if (err) throw err;
  };
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
      // local/ui: the GitHub card's org list lives in `credentials` too.
      if (key === "BUTCHR_GITHUB_ORGS" && response.credentials) {
        const orgs = value.split(",").map((o) => o.trim()).filter(Boolean);
        response = { ...response, credentials: { ...response.credentials, github: { ...response.credentials.github, orgs, orgsSource: "file" } } };
      }
      // local/ui: and the Zendesk subdomain / Trello board id.
      if (key === "ZENDESK_SUBDOMAIN" && response.credentials) {
        response = { ...response, credentials: { ...response.credentials, zendesk: { ...response.credentials.zendesk, subdomain: { value, source: "file", editable: true, running: response.credentials.zendesk.subdomain.running } } } };
      }
      if (key === "TRELLO_BOARD_ID" && response.credentials) {
        response = { ...response, credentials: { ...response.credentials, trello: { ...response.credentials.trello, boardId: { value, source: "file", editable: true, running: response.credentials.trello.boardId.running } } } };
      }
      return response;
    },
    async restartDaemon() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextRestartError) {
        const err = nextRestartError;
        nextRestartError = undefined;
        throw err;
      }
      // local/ui: the restarted butchr runs what's saved, and has a new start time.
      const c = response.credentials;
      if (c) {
        response = {
          ...response,
          credentials: {
            ...c,
            github: { ...c.github, runningOrgs: [...c.github.orgs], active: c.github.token.exists && c.github.orgs.length > 0 },
            zendesk: { ...c.zendesk, subdomain: { ...c.zendesk.subdomain, running: c.zendesk.subdomain.value } },
            trello: { ...c.trello, boardId: { ...c.trello.boardId, running: c.trello.boardId.value } },
            restart: { ...c.restart, startedAt: new Date(Date.parse(c.restart.startedAt) + 60_000).toISOString() },
          },
        };
      }
    },
    async testGithubConnection() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const result = nextGithubTest ?? {
        ok: true,
        login: "octocat",
        httpStatusClass: "2xx" as const,
        orgs: (response.credentials?.github.orgs ?? []).map((org) => ({ org, ok: true, httpStatusClass: "2xx" as const })),
      };
      nextGithubTest = undefined;
      return result;
    },
    async writeGithubToken() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (nextGithubWriteError) {
        const err = nextGithubWriteError;
        nextGithubWriteError = undefined;
        throw err;
      }
      const rotated = response.credentials?.github.token.exists ?? false;
      if (response.credentials) {
        const token = response.credentials.github.token;
        response = { ...response, credentials: { ...response.credentials, github: { ...response.credentials.github, token: { ...token, source: token.source === "unset" ? "secrets-file" : token.source, exists: true, readable: true, mode: 0o600, tooOpen: false } } } };
      }
      return { ok: true, login: "octocat", rotated, restartNeeded: true };
    },
    async testProviderConnection(provider) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const result = nextProviderTest ?? (provider === "zendesk" ? { ok: true, account: "agent@example.com" } : { ok: true, account: "butchr-bot", board: "Support" });
      nextProviderTest = undefined;
      return result;
    },
    async writeZendeskToken() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      takeProviderWriteError();
      const rotated = response.credentials?.zendesk.token.exists ?? false;
      if (response.credentials) response = { ...response, credentials: { ...response.credentials, zendesk: { ...response.credentials.zendesk, token: writtenToken(response.credentials.zendesk.token) } } };
      return { ok: true, account: "agent@example.com", rotated, restartNeeded: true };
    },
    async writeTrelloCredentials() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      takeProviderWriteError();
      const rotated = response.credentials?.trello.token.exists ?? false;
      if (response.credentials) {
        const trello = response.credentials.trello;
        response = { ...response, credentials: { ...response.credentials, trello: { ...trello, apiKey: writtenToken(trello.apiKey), token: writtenToken(trello.token) } } };
      }
      return { ok: true, account: "butchr-bot", rotated, restartNeeded: true };
    },
  };
}

/** local/ui — what `vite dev` shows: the upstream fixture plus a credentials summary like this Mac's. */
export function localUiSettingsFixture(): SettingsResponse {
  const base = defaultSettingsFixture();
  return {
    ...base,
    // FACTORY-66's switches: one left at its default, one saved off, one off in the environment, and the read-only Atlassian kill switch.
    settings: [
      ...base.settings,
      { key: "BUTCHR_ATLASSIAN_ENABLED", value: null, source: "default", restartNeeded: true, secret: false, editable: false, description: "Explicit kill switch for the whole Atlassian credential (jira-work/jira-idea/jira-project/confluence-page together). Default enabled." },
      { key: "BUTCHR_PROVIDER_JIRA_WORK_ENABLED", value: null, source: "default", restartNeeded: true, secret: false, editable: true, description: "Independent on/off switch for the jira-work rule provider. Default enabled." },
      { key: "BUTCHR_PROVIDER_GITHUB_PR_ENABLED", value: "false", source: "file", restartNeeded: true, secret: false, editable: true, description: "Independent on/off switch for the github-pr rule provider. Default enabled." },
      { key: "BUTCHR_PROVIDER_TRELLO_CARD_ENABLED", value: "false", source: "environment", restartNeeded: true, secret: false, editable: true, description: "Independent on/off switch for the trello-card rule provider. Default enabled." },
    ],
    credentials: {
      atlassian: {
        site: "https://example.atlassian.net",
        email: "butchr@example.com",
        token: { source: "env-file", fileEnvKey: "ATLASSIAN_TOKEN_FILE", path: "/Users/you/.config/butchr/atlassian-token", exists: true, readable: true, mode: 0o600, tooOpen: false, readOnlyReason: null },
      },
      github: {
        token: { source: "unset", fileEnvKey: "GITHUB_TOKEN_FILE", path: "/Users/you/.config/butchr/secrets/github-token", exists: false, readable: false, mode: null, tooOpen: null, readOnlyReason: null },
        orgs: [],
        orgsSource: "default",
        orgsEditable: true,
        active: false,
        runningOrgs: [],
      },
      zendesk: {
        subdomain: { value: null, source: "default", editable: true, running: null },
        token: { source: "unset", fileEnvKey: "ZENDESK_OAUTH_TOKEN_FILE", path: "/Users/you/.config/butchr/secrets/zendesk-oauth-token", exists: false, readable: false, mode: null, tooOpen: null, readOnlyReason: null },
        riskAccepted: false,
      },
      trello: {
        boardId: { value: null, source: "default", editable: true, running: null },
        apiKey: { source: "unset", fileEnvKey: "TRELLO_API_KEY_FILE", path: "/Users/you/.config/butchr/secrets/trello-api-key", exists: false, readable: false, mode: null, tooOpen: null, readOnlyReason: null },
        token: { source: "unset", fileEnvKey: "TRELLO_TOKEN_FILE", path: "/Users/you/.config/butchr/secrets/trello-token", exists: false, readable: false, mode: null, tooOpen: null, readOnlyReason: null },
        riskAccepted: false,
      },
      setupCode: {
        command: "launchctl kill SIGUSR2 gui/$(id -u)/com.example.butchr",
        findCommand: "grep 'setup code' /Users/you/Library/Logs/butchr.log | tail -1",
        where: "butchr's log (/Users/you/Library/Logs/butchr.log)",
      },
      restart: { supported: true, supervisor: "launchd", startedAt: "2026-10-16T00:00:00.000Z" },
    },
  };
}

/**
 * local/ui — same dev/prod switch as `api/rules.ts`'s `rulesApi`: `vite dev`
 * gets in-memory fixtures (`localUiSettingsFixture`), a production build the
 * real routes. Tests import `realSettingsApi`/`createFixturesSettingsApi`
 * directly instead.
 */
const viteEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
export const settingsApi: SettingsApi = viteEnv?.["DEV"] === true ? createFixturesSettingsApi({ response: localUiSettingsFixture() }) : realSettingsApi;
