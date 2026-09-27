/**
 * FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): a REUSABLE
 * bearer-token + Origin-allowlist guard for daemon HTTP routes that must
 * NOT be open the way `/health`, `/state`, `/dashboard` and `/agents`
 * already are — built once here, not endpoint-specific, because the
 * ticket's own later terminal story (Clevr's actual terminal-attach flow)
 * reuses this exact mechanism rather than inventing a second one.
 *
 * TOKEN UNSET MEANS DISABLED, NOT OPEN: a route wired to this guard must
 * never fall back to "no auth configured, so allow everything" — the
 * opposite of every other optional `Config` section in this codebase
 * (`github`, `rocketchat`), which degrade to "the FEATURE is off", not "the
 * feature is on with no protection". `checkBearerOrigin`/
 * `preflightBearerOrigin` return a 503 refusal whenever `deps.token` is
 * `undefined`, before either even looks at the rest of the request.
 *
 * ORIGIN CHECK BEFORE BEARER CHECK, DELIBERATELY: a request carrying a
 * non-allowlisted `Origin` is refused before its `Authorization` header is
 * even inspected — a caller probing origins never learns "the origin was
 * wrong but at least try a real token", and a caller with a stolen token
 * still can't use it from an unlisted extension id. CORS response headers
 * are emitted ONLY for an allowlisted origin, and NEVER as `*`: this
 * mechanism's whole point is that only a specific extension id may read the
 * response, so a wildcard would defeat that even while the bearer token
 * still gates every other caller.
 *
 * CONSTANT-TIME COMPARISON: token comparison uses `node:crypto`'s
 * `timingSafeEqual`, never `===` or a hand-rolled loop, so an early-exit
 * byte comparison can't leak how many leading bytes of a caller's guess
 * matched the real token. `timingSafeEqual` itself throws on mismatched
 * buffer lengths, which would otherwise make "how long is the real token"
 * a free, timing-observable question — a length mismatch is instead
 * compared against ITSELF (same cost, always false) so the two cases cost
 * about the same.
 */
import { timingSafeEqual } from "node:crypto";

export interface BearerOriginGuardDeps {
  /** `undefined` disables every route wired to this guard — never treat this as "no auth required". */
  token: string | undefined;
  /** `chrome-extension://<id>` origins allowed to read the guarded response. */
  allowedOrigins: readonly string[];
}

export type GuardOutcome =
  | { ok: true; corsHeaders: Record<string, string> }
  | { ok: false; status: number; body: { error: string }; corsHeaders: Record<string, string> };

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Burn a comparably-timed operation rather than short-circuiting on
    // length alone — see this module's own header.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** CORS headers for an ALLOWLISTED origin only — never call this for a disallowed or absent origin. */
function corsHeadersFor(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/**
 * The whole guard for an actual (non-preflight) request. `authorization`/
 * `origin` are `null` when the header is absent — pass `Request.headers.get(...)`
 * straight through. Never throws.
 */
export function checkBearerOrigin(req: { authorization: string | null; origin: string | null }, deps: BearerOriginGuardDeps): GuardOutcome {
  if (deps.token === undefined) {
    return { ok: false, status: 503, body: { error: "endpoint disabled: no token configured" }, corsHeaders: {} };
  }
  if (req.origin !== null && !deps.allowedOrigins.includes(req.origin)) {
    return { ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {} };
  }
  const corsHeaders = req.origin !== null ? corsHeadersFor(req.origin) : {};
  const expected = `Bearer ${deps.token}`;
  if (!req.authorization || !constantTimeEqual(req.authorization, expected)) {
    return { ok: false, status: 401, body: { error: "unauthorized" }, corsHeaders };
  }
  return { ok: true, corsHeaders };
}

/**
 * The CORS preflight (`OPTIONS`) response for a route guarded by
 * `checkBearerOrigin`. A preflight never carries `Authorization` — browsers
 * exclude it from the preflight itself, listing it only inside
 * `Access-Control-Request-Headers` — so this checks the disabled state and
 * the origin only, never a token.
 */
export function preflightBearerOrigin(req: { origin: string | null }, deps: BearerOriginGuardDeps): { status: number; headers: Record<string, string> } {
  if (deps.token === undefined) return { status: 503, headers: {} };
  if (req.origin === null || !deps.allowedOrigins.includes(req.origin)) return { status: 403, headers: {} };
  return {
    status: 204,
    headers: {
      ...corsHeadersFor(req.origin),
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Authorization",
    },
  };
}

/** `chrome-extension://<32-char id>` — a real Chrome extension id is always exactly 32 lowercase letters `a`-`p` (base16 over that alphabet), never anything else. */
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/** True only for a well-formed `chrome-extension://<id>` origin — used to validate `BUTCHR_EXTENSION_ORIGINS` entries at config-load time, before any request is ever checked against them. */
export const isExtensionOrigin = (origin: string): boolean => EXTENSION_ORIGIN_RE.test(origin);
