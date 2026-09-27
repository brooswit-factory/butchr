/**
 * FACTORY-134 (task 1/2 of story FACTORY-22): typed config parsing for the
 * Catamorbius SSE client, following `../config/config.ts`'s own conventions
 * — `readFile` injected so parsing stays pure/testable (same shape as
 * `loadConfig`), a `*_TOKEN_FILE` path rather than a bare token in the
 * environment (same convention as `ATLASSIAN_TOKEN_FILE`/
 * `GITHUB_TOKEN_FILE`), and malformed values failing loudly (thrown, never
 * silently coerced) exactly like every numeric knob in `loadConfig`.
 *
 * DELIBERATELY SEPARATE FROM `../config/config.ts`'s `Config`/`ConfigEnv`/
 * `loadConfig`: this ticket builds the client with NO daemon wiring — no
 * change to what the daemon actually reads at startup. Keeping this a
 * standalone module (not a new optional field on `Config`) is a large part
 * of how that's guaranteed rather than merely intended: nothing calls
 * `loadCatamorbiusConfig` today, so its being unconfigured or misconfigured
 * cannot affect a running daemon. Task 2 (FACTORY-137) wires it in.
 *
 * ALL-OR-NOTHING, OFF BY DEFAULT: `loadCatamorbiusConfig` returns
 * `undefined` whenever `CATAMORBIUS_URL` is unset — the same "absent means
 * disabled, never a startup crash for unrelated config" contract
 * `loadConfig`'s own `github`/`rocketchat` optional blocks use. Once the URL
 * IS set, every other value is validated and a malformed one throws (same
 * "loud once you've opted in" contract those blocks use too).
 */

export interface CatamorbiusConfig {
  /** Trailing slashes stripped, same normalization `loadConfig` applies to `ATLASSIAN_SITE`. */
  baseUrl: string;
  /** Bearer token for `GET /events`, read from `CATAMORBIUS_TOKEN_FILE` — never the raw environment or argv. */
  token: string;
  /**
   * Liveness watchdog window: no bytes (an event OR a heartbeat comment) for
   * this long means the connection is presumed dead. Default 45000 — 3x the
   * gateway's DOCUMENTED default heartbeat interval (`CATAMORBIUS_HEARTBEAT_MS`,
   * default 15000, per the gateway's own README). The true interval is a
   * server-side setting this client cannot query or assume unchanged, so 3x
   * the documented default is a margin against jitter/slow ticks, not a
   * guarantee — see docs/catamorbius-push.md.
   */
  watchdogMs: number;
  /** Reconnect backoff starting point (exponential, jittered) before the server's own "retry:" hint is applied as a floor. */
  backoffBaseMs: number;
  /** Reconnect backoff ceiling. */
  backoffCapMs: number;
  /** Timeout for the read-only `GET /healthz` reachability probe. */
  probeTimeoutMs: number;
}

export interface CatamorbiusConfigEnv {
  CATAMORBIUS_URL?: string | undefined;
  CATAMORBIUS_TOKEN_FILE?: string | undefined;
  CATAMORBIUS_WATCHDOG_MS?: string | undefined;
  CATAMORBIUS_BACKOFF_BASE_MS?: string | undefined;
  CATAMORBIUS_BACKOFF_CAP_MS?: string | undefined;
  CATAMORBIUS_PROBE_TIMEOUT_MS?: string | undefined;
}

/** The gateway's own documented default heartbeat interval (`CATAMORBIUS_HEARTBEAT_MS`'s default, per its README) — the basis `DEFAULT_WATCHDOG_MS` multiplies, not a value this client can query at runtime. */
const DOCUMENTED_DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_WATCHDOG_MS = DOCUMENTED_DEFAULT_HEARTBEAT_MS * 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 60000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} is not a positive number: ${JSON.stringify(raw)}`);
  return n;
}

/**
 * `readFile` is injected so config parsing stays pure and testable — same
 * signature as `../config/config.ts`'s `loadConfig`. Returns `undefined`
 * (feature off) when `CATAMORBIUS_URL` is unset; throws on any malformed
 * value once it IS set.
 */
export function loadCatamorbiusConfig(env: CatamorbiusConfigEnv, readFile: (path: string) => string): CatamorbiusConfig | undefined {
  const rawUrl = env.CATAMORBIUS_URL?.trim();
  if (!rawUrl) return undefined;

  const tokenFile = env.CATAMORBIUS_TOKEN_FILE?.trim();
  if (!tokenFile) throw new Error("CATAMORBIUS_URL is set but CATAMORBIUS_TOKEN_FILE is not — a token file is required whenever the gateway URL is configured (never a bare CATAMORBIUS_TOKEN in the environment)");
  const token = readFile(tokenFile).trim();
  if (!token) throw new Error("Catamorbius token is empty");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`CATAMORBIUS_URL is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`CATAMORBIUS_URL must be http(s): ${JSON.stringify(rawUrl)}`);

  const watchdogMs = positiveNumber(env.CATAMORBIUS_WATCHDOG_MS, DEFAULT_WATCHDOG_MS, "CATAMORBIUS_WATCHDOG_MS");
  const backoffBaseMs = positiveNumber(env.CATAMORBIUS_BACKOFF_BASE_MS, DEFAULT_BACKOFF_BASE_MS, "CATAMORBIUS_BACKOFF_BASE_MS");
  const backoffCapMs = positiveNumber(env.CATAMORBIUS_BACKOFF_CAP_MS, DEFAULT_BACKOFF_CAP_MS, "CATAMORBIUS_BACKOFF_CAP_MS");
  if (backoffCapMs < backoffBaseMs) throw new Error(`CATAMORBIUS_BACKOFF_CAP_MS (${backoffCapMs}) must be >= CATAMORBIUS_BACKOFF_BASE_MS (${backoffBaseMs})`);
  const probeTimeoutMs = positiveNumber(env.CATAMORBIUS_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS, "CATAMORBIUS_PROBE_TIMEOUT_MS");

  return { baseUrl: rawUrl.replace(/\/+$/, ""), token, watchdogMs, backoffBaseMs, backoffCapMs, probeTimeoutMs };
}
