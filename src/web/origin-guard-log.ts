import type { GuardRejectReason } from "./origin-guard.js";

/**
 * FACTORY-476 (implementing FACTORY-474): makes an extension-origin guard
 * rejection (`src/web/origin-guard.ts`'s `checkExtensionOrigin`/
 * `preflightExtensionOrigin`) DIAGNOSABLE from the journal. Before this
 * ticket, a rejected `GET`/`POST`/`OPTIONS /resources/for-url` or
 * `GET /agents/:agentKey/pty` produced a bare 403 and nothing else — "origin
 * required" vs "origin not allowed" vs "allowlist empty" (an operator
 * misconfiguration) could not be told apart without reproducing the request
 * by hand.
 *
 * WHAT IS LOGGED, AND WHY IT'S SAFE: method, the request path WITHOUT its
 * query string (the query on `/resources/for-url` carries the page URL the
 * extension is looking at — never logged), the `Origin` header verbatim (a
 * `chrome-extension://<id>`, not a secret — see `origin-guard.ts`'s own
 * header) or the literal `"absent"`, and the guard's own `GuardRejectReason`.
 * `path` and `origin` still go through `sanitizeField`-style flattening
 * before they reach the line (bounded length, whitespace collapsed) even
 * though today's callers only ever pass a fixed route path: `origin` in
 * particular is attacker-controlled (any local process can set an arbitrary
 * `Origin` header by hand — see `origin-guard.ts`'s own threat model), and
 * `installLogSink` (`src/daemon/log-sink.ts`) only backstops raw newlines,
 * not the "one line, cleanly delimited fields" shape a reader parsing this
 * tag relies on.
 *
 * RATE-LIMIT/DEDUPE (ticket criterion 3): at most one line per distinct
 * (method, path, origin, result) per `windowMs` (default 60s) — a polling
 * extension retrying the same rejected request can't flood the journal.
 * CHOICE STATED: method IS part of the dedupe key (the ticket left this
 * caller's choice) — `OPTIONS` and `GET` on the same path are a genuinely
 * different pair of calls (a browser always preflights before the real
 * request), so collapsing them together would suppress the GET's own first
 * rejection whenever its preflight had already logged one moments earlier.
 * The clock is injectable (`now`) so a test can advance a window without
 * sleeping. The dedupe map is bounded by PRUNING expired entries on every
 * call (never unboundedly growing) — necessary because `origin` (part of
 * the key) is attacker-controlled, so an attacker varying it on every
 * request could otherwise grow this map without limit.
 */
export const ORIGIN_GUARD_TAG = "[origin-guard]";

export interface OriginGuardRejection {
  method: string;
  /** The request path, WITHOUT its query string — see this module's own header. */
  path: string;
  /** `Request.headers.get("origin")`, straight through — `null` means absent. */
  origin: string | null;
  result: GuardRejectReason;
}

const MAX_FIELD_CHARS = 200;

/** Same discipline as `src/tools/outcome.ts`'s `sanitizeField`: flatten raw newlines to a visible marker (belt-and-braces alongside `installLogSink`'s own backstop), collapse remaining whitespace so this field can't be mistaken for a field boundary, and bound length against an attacker-controlled value. */
function sanitizeField(raw: string): string {
  const flattened = raw.replace(/\r\n|\r|\n/g, " ⏎ ").replace(/\s+/g, (m) => (m.includes("⏎") ? m : "_"));
  return flattened.length > MAX_FIELD_CHARS ? `${flattened.slice(0, MAX_FIELD_CHARS)}…` : flattened;
}

function originGuardLine(r: OriginGuardRejection): string {
  const method = sanitizeField(r.method);
  const path = sanitizeField(r.path);
  const origin = sanitizeField(r.origin ?? "absent");
  // `result` is always one of the three fixed `GuardRejectReason` literals —
  // never attacker-controlled text — so it needs no sanitizing, and is put
  // last (free text to end of line) the same way `[tools2]`'s and
  // `[notify-suppressed]`'s own trailing `msg=` field is.
  return `${ORIGIN_GUARD_TAG} method=${method} path=${path} origin=${origin} result=${r.result}`;
}

export interface OriginGuardLoggerDeps {
  /** Injected clock (ms epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Where a line is written; defaults to `console.error` (patched by `installLogSink` at daemon boot, same as every other emitter in this codebase). */
  log?: (line: string) => void;
  /** Dedupe/rate-limit window, in ms; defaults to 60_000 (ticket criterion 3's "per minute"). */
  windowMs?: number;
}

export interface OriginGuardLogger {
  /** Call on every guard rejection — never on an allowed request (criterion 4: those log nothing). Dedupes/rate-limits internally; see this module's own header. */
  reject(r: OriginGuardRejection): void;
}

export function createOriginGuardLogger(deps: OriginGuardLoggerDeps = {}): OriginGuardLogger {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const windowMs = deps.windowMs ?? 60_000;
  const lastEmittedAt = new Map<string, number>();

  return {
    reject(r) {
      const t = now();
      // Prune every call, not on a timer: bounds this map's memory against
      // an attacker varying `origin` (part of the key) on every request —
      // see this module's own header.
      for (const [key, ts] of lastEmittedAt) {
        if (t - ts >= windowMs) lastEmittedAt.delete(key);
      }
      const key = `${r.method}\0${r.path}\0${r.origin ?? ""}\0${r.result}`;
      const last = lastEmittedAt.get(key);
      if (last !== undefined && t - last < windowMs) return;
      lastEmittedAt.set(key, t);
      log(originGuardLine(r));
    },
  };
}
