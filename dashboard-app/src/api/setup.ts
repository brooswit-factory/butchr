/**
 * FACTORY-665 (PR-2) — the ONE client module the Setup page and the Jira
 * token-rotation control talk to. Shapes read off the real server
 * (`src/web/setup-api.ts`), never invented. Same "two implementations
 * behind one interface" pattern every other API module here follows
 * (`api/settings.ts`, `api/rules.ts`): `realSetupApi` hits the real
 * endpoints; `createFixturesSetupApi` lets tests/dev rehearse every state
 * (unconfigured, setup-code wrong/expired/locked, site-shape-invalid,
 * test ok/failed, account-mismatch, env-provided-409, rate-limited) with
 * no network at all.
 */

export interface SetupStatusResponse {
  configured: boolean;
}

export interface JiraWriteOk {
  ok: true;
  accountId: string;
  displayName: string;
  rotated: boolean;
  restartNeeded: true;
  /** Setup mode only: the daemon is exiting so its supervisor restarts it in normal mode; the page polls until it is back. */
  restarting?: true;
  identityPersisted: boolean;
  identityError?: string;
}

/** Thrown by `submitSetup`/`rotateToken` for a 429 — same shape/discipline as `api/settings.ts`'s own `RateLimitError`. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds: number | undefined) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown for the server's own 409 ("provided by environment") — distinguished from a plain `Error` so the UI can show its own fixed guidance rather than a generic failure message. */
export class ProvidedByEnvironmentError extends Error {
  constructor() {
    super("provided by environment");
    this.name = "ProvidedByEnvironmentError";
  }
}

export interface SetupApi {
  getStatus(signal?: AbortSignal): Promise<SetupStatusResponse>;
  /** `POST /api/setup/jira` — setup mode only. */
  submitSetup(input: { site: string; email: string; token: string; setupCode: string }, signal?: AbortSignal): Promise<JiraWriteOk>;
  /** `PUT /api/settings/jira/token` — configured mode, rotation (site/email are NOT resubmitted; the server reuses its own already-loaded values). */
  rotateToken(input: { token: string; setupCode: string }, signal?: AbortSignal): Promise<JiraWriteOk>;
}

const CSRF_HEADER = "x-butchr-csrf";

async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function postJson(path: string, method: "POST" | "PUT", body: unknown, signal?: AbortSignal): Promise<JiraWriteOk> {
  const csrfToken = await fetchCsrfToken(signal);
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let message = `${path}: HTTP ${res.status}`;
    try {
      const errBody: unknown = await res.json();
      if (errBody && typeof errBody === "object" && typeof (errBody as { error?: unknown }).error === "string") message = (errBody as { error: string }).error;
    } catch { /* non-JSON error body: keep the generic message */ }
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const parsed = header !== null ? Number.parseInt(header, 10) : NaN;
      throw new RateLimitError(message, Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined);
    }
    if (res.status === 409) throw new ProvidedByEnvironmentError();
    throw new Error(message);
  }
  return (await res.json()) as JiraWriteOk;
}

export const realSetupApi: SetupApi = {
  async getStatus(signal) {
    const res = await fetch("/api/setup/status", signal ? { signal } : {});
    if (!res.ok) throw new Error(`/api/setup/status: HTTP ${res.status}`);
    return (await res.json()) as SetupStatusResponse;
  },
  submitSetup(input, signal) {
    return postJson("/api/setup/jira", "POST", input, signal);
  },
  rotateToken(input, signal) {
    return postJson("/api/settings/jira/token", "PUT", input, signal);
  },
};

export interface FixturesSetupApiOptions {
  status?: SetupStatusResponse;
  /** One-shot: consumed by the next `submitSetup`/`rotateToken` call, then cleared. Defaults to a success result. */
  nextResult?: JiraWriteOk | { throw: Error };
  nextRateLimit?: { retryAfterSeconds?: number };
  latencyMs?: number;
}

export function defaultSetupSuccess(overrides: Partial<JiraWriteOk> = {}): JiraWriteOk {
  return { ok: true, accountId: "stub-account", displayName: "Stub Account", rotated: false, restartNeeded: true, identityPersisted: true, ...overrides };
}

export function createFixturesSetupApi(opts: FixturesSetupApiOptions = {}): SetupApi {
  let nextResult = opts.nextResult;
  let nextRateLimit = opts.nextRateLimit;
  const latencyMs = opts.latencyMs ?? 0;
  const status = opts.status ?? { configured: false };

  async function respond(): Promise<JiraWriteOk> {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    if (nextRateLimit) {
      const retryAfterSeconds = nextRateLimit.retryAfterSeconds;
      nextRateLimit = undefined;
      throw new RateLimitError("rate limited: too many attempts", retryAfterSeconds);
    }
    const result = nextResult ?? defaultSetupSuccess();
    nextResult = undefined;
    if ("throw" in result) throw result.throw;
    return result;
  }

  return {
    async getStatus() {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return status;
    },
    submitSetup: () => respond(),
    rotateToken: () => respond(),
  };
}
