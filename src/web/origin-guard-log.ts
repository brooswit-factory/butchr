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
 * `Origin` header by hand — see `origin-guard.ts`'s own threat model).
 *
 * ROUTE-PATTERN NORMALIZATION (FACTORY-502, ticket criterion (a)):
 * `normalizeRoutePattern` below rewrites `/agents/<agentKey>/pty` to the
 * literal `/agents/:agentKey/pty` before `path` is used for EITHER the
 * dedupe key OR the printed line — the agent key itself is never the thing
 * that varies either. This was FACTORY-474's own flood vector: `path` is
 * `new URL(request.url).pathname`, which for the PTY route contains the
 * agent key, so an attacker varying the key on every request used to get a
 * fresh dedupe-key and a fresh journal line per request, unbounded (see
 * FACTORY-330 comment 27891 for the director's own account of missing
 * this across three reviews of #563). Printing the PATTERN rather than the
 * raw path is a deliberate choice, not just the dedupe key's: it also keeps
 * a caller-chosen agent key out of the journal line itself, the same
 * "don't log more than the guard needs to be diagnosable" discipline this
 * module already applies to the query string. A fixed-path route like
 * `/resources/for-url` is unaffected — `normalizeRoutePattern` returns it
 * unchanged.
 *
 * RATE-LIMIT/DEDUPE (ticket criterion 3 of FACTORY-474, tightened by
 * FACTORY-502): at most one line per distinct (method, ROUTE PATTERN,
 * origin, result) per `windowMs` (default 60s) — a polling extension
 * retrying the same rejected request, or an attacker varying only the PTY
 * route's agent key, can't flood the journal. CHOICE STATED: method IS part
 * of the dedupe key (the ticket left this caller's choice) — `OPTIONS` and
 * `GET` on the same path are a genuinely different pair of calls (a browser
 * always preflights before the real request), so collapsing them together
 * would suppress the GET's own first rejection whenever its preflight had
 * already logged one moments earlier. The clock is injectable (`now`) so a
 * test can advance a window without sleeping.
 *
 * FOUR INDEPENDENT BOUNDS keep this module's memory and journal output
 * bounded even against an attacker who varies EVERY key field on every
 * request (FACTORY-502, director's decision on FACTORY-330 comment 27886):
 *
 * (a) Dedupe on the route pattern, not the raw path — see above.
 * (b) `maxLinesPerWindow`: a GLOBAL cap on rejection lines emitted per
 *     window, independent of how many distinct keys are involved. Once it's
 *     reached, further would-be-distinct rejections in the same window are
 *     counted, not logged, and a single `${ORIGIN_GUARD_TAG} suppressed=N`
 *     line is emitted for the count once the window rolls over — never
 *     silently dropped, because a cap that merely stops logging recreates
 *     the exact blindness this ticket exists to remove. That suppressed-line
 *     emission is itself bounded to at most once per window (see
 *     `maybeEmitSuppressedLine` below) so it cannot become its own flood
 *     vector.
 * (c) `maxMapSize`: a hard cap on the dedupe map's own size, enforced ON
 *     INSERT of a new (never-seen-or-expired) key. When the map is already
 *     at capacity, a new key is counted as suppressed (same counter as (b))
 *     rather than inserted — memory stays bounded even when every request
 *     in a window carries a distinct key (e.g. a distinct `origin`, which is
 *     attacker-controlled).
 * (d) The prune below stops at the FIRST unexpired entry instead of
 *     scanning the whole map every call. THIS IS ONLY SOUND BECAUSE OF AN
 *     INVARIANT THIS MODULE MUST PRESERVE: insertion order in `lastEmittedAt`
 *     always tracks timestamp order. Concretely: a LIVE key (found, not
 *     expired) returns early WITHOUT calling `.set` again — `Map.set` on an
 *     existing key updates its value but does NOT move it in iteration
 *     order, so re-`set`ing a live key would leave a stale (small)
 *     timestamp sitting at its ORIGINAL position while a newer one is
 *     recorded, breaking the "insertion order == timestamp order"
 *     assumption the early-exit prune depends on. An EXPIRED key being
 *     replaced is deleted first, then re-`set`, so it re-appends at the end
 *     in its new, later position. Any future change to this function that
 *     starts re-`set`ing a live key (e.g. to "refresh" its TTL) SILENTLY
 *     breaks the early-exit prune's correctness — the map would still
 *     shrink over time (nothing loops forever), but a live entry could sit
 *     ahead of an already-expired one and stop the prune early, leaking
 *     expired entries indefinitely. Do not change this without re-deriving
 *     the invariant. See `test/unit/origin-guard-log.test.ts`'s
 *     "early-exit prune" tests, which fail if the early exit stops pruning
 *     correctly.
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

/** The only guarded route with a variable path segment today — see this module's own header, "ROUTE-PATTERN NORMALIZATION". Any future guarded route with its own dynamic segment needs its own pattern added here. */
const PTY_ROUTE_RE = /^\/agents\/[^/]+\/pty$/;

/** Collapses a raw request path to its route PATTERN before it's used as a dedupe key or printed — see this module's own header. A path that isn't a known dynamic route (e.g. the fixed `/resources/for-url`) is returned unchanged. */
function normalizeRoutePattern(path: string): string {
  if (PTY_ROUTE_RE.test(path)) return "/agents/:agentKey/pty";
  return path;
}

function originGuardLine(r: OriginGuardRejection, pattern: string): string {
  const method = sanitizeField(r.method);
  const path = sanitizeField(pattern);
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
  /** Dedupe/rate-limit window, in ms; defaults to 60_000 (ticket criterion 3's "per minute"). Also the window the global-lines cap (b) and the suppressed-line cap (b) are measured against — see this module's own header. */
  windowMs?: number;
  /** FACTORY-502 criterion (b): the max number of DISTINCT rejection lines emitted per `windowMs` window, across every key — independent of `maxMapSize`. Default 200. */
  maxLinesPerWindow?: number;
  /** FACTORY-502 criterion (c): the max number of entries the dedupe map may hold at once, enforced on insert of a new (never-seen-or-expired) key. Default 500. */
  maxMapSize?: number;
}

export interface OriginGuardLogger {
  /** Call on every guard rejection — never on an allowed request (criterion 4: those log nothing). Dedupes/rate-limits internally; see this module's own header. */
  reject(r: OriginGuardRejection): void;
}

export function createOriginGuardLogger(deps: OriginGuardLoggerDeps = {}): OriginGuardLogger {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const windowMs = deps.windowMs ?? 60_000;
  const maxLinesPerWindow = deps.maxLinesPerWindow ?? 200;
  const maxMapSize = deps.maxMapSize ?? 500;
  const lastEmittedAt = new Map<string, number>();

  // FACTORY-502 criterion (b) bookkeeping: `windowIndex` is a fixed,
  // non-overlapping bucket (`floor(t / windowMs)`), NOT the sliding window
  // the per-key dedupe above uses — a fixed bucket is what lets "the global
  // cap resets, and the suppressed-line count for the window that just
  // ended is flushed" be a single cheap index comparison, with no timer.
  // `null` (not `-1`) marks "no window observed yet" so it can never
  // collide with the real bucket index 0.
  let windowIndex: number | null = null;
  let linesEmittedInWindow = 0;
  let suppressedInWindow = 0;

  /** Rolls to `t`'s fixed window bucket if it differs from the current one, flushing the PRIOR window's suppressed count as a single line first (bounded to at most one per window: this only ever runs once per bucket transition, on whichever `reject()` call first observes it — see this module's own header, criterion (b)). No timer: a window with suppressions that is never followed by another `reject()` call simply never flushes, which is the same "no real timers" discipline the per-key dedupe already relies on for tests. */
  function rollWindowIfNeeded(t: number): void {
    const idx = Math.floor(t / windowMs);
    if (idx === windowIndex) return;
    if (windowIndex !== null && suppressedInWindow > 0) {
      log(`${ORIGIN_GUARD_TAG} suppressed=${suppressedInWindow}`);
    }
    windowIndex = idx;
    linesEmittedInWindow = 0;
    suppressedInWindow = 0;
  }

  return {
    reject(r) {
      const t = now();
      // Prune from the front only, stopping at the first unexpired entry —
      // sound ONLY under the insertion-order-tracks-timestamp-order
      // invariant this module's own header derives and this function must
      // preserve. See the header's criterion (d) before changing anything
      // below that touches `lastEmittedAt`.
      for (const [key, ts] of lastEmittedAt) {
        if (t - ts < windowMs) break;
        lastEmittedAt.delete(key);
      }
      rollWindowIfNeeded(t);

      const pattern = normalizeRoutePattern(r.path);
      const key = `${r.method}\0${pattern}\0${r.origin ?? ""}\0${r.result}`;
      const last = lastEmittedAt.get(key);
      if (last !== undefined && t - last < windowMs) return; // live key: ordinary dedupe, never re-`set` (criterion (d))

      // From here the key is either brand new or was just pruned as
      // expired — either way it needs a fresh insert, which is the only
      // place either capacity bound (b)/(c) applies.
      if (lastEmittedAt.size >= maxMapSize) {
        // Criterion (c): map already at capacity — don't grow it. Counted
        // the same as a global-cap suppression (b); the operator-facing
        // signal is the same either way: "N rejections were dropped".
        suppressedInWindow++;
        return;
      }
      if (linesEmittedInWindow >= maxLinesPerWindow) {
        // Criterion (b): still track the key (bounded map capacity
        // allowing) so a repeat of the SAME key doesn't inflate the
        // suppressed count further this window — only genuinely new
        // rejections do.
        lastEmittedAt.set(key, t);
        suppressedInWindow++;
        return;
      }
      lastEmittedAt.set(key, t);
      linesEmittedInWindow++;
      log(originGuardLine(r, pattern));
    },
  };
}
