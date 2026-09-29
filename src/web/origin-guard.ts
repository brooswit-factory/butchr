/**
 * FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): a REUSABLE
 * Origin-allowlist guard for daemon HTTP routes that must NOT be open the
 * way `/health`, `/state`, `/dashboard` and `/agents` already are — built
 * once here, not endpoint-specific, because `GET /agents/:agentKey/pty`
 * (FACTORY-453) reuses this exact mechanism rather than inventing a second
 * one.
 *
 * FACTORY-464/FACTORY-465 dropped this guard's original bearer-token half
 * (`BUTCHR_EXTENSION_TOKEN`) entirely — an operator-decided, deliberate
 * security-posture change: the daemon binds loopback-only
 * (`src/daemon/listen.ts`), and the operator judged that, on a single-user
 * local box, an Origin-allowlist-only check is enough. THE TRADEOFF, STATED
 * PLAINLY: `Origin` is enforced by the BROWSER, so this still protects
 * against another website open in a browser tab — but it does NOT protect
 * against another local process (a script, another user, `curl`) that sets
 * `Origin: chrome-extension://<allowlisted-id>` by hand. Nothing in this
 * file can distinguish that forged header from the real extension. This is
 * accepted, not overlooked.
 *
 * FAIL-CLOSED BY CONSTRUCTION: an empty/unset `allowedOrigins` rejects every
 * origin (including an absent one), because `checkExtensionOrigin` and
 * `preflightExtensionOrigin` both require a PRESENT `Origin` that appears in
 * the list — there is no "no allowlist configured, so allow everything"
 * path. This is the same "never silently open" discipline the old
 * bearer-token half enforced via `token === undefined`, now enforced by the
 * Origin check alone.
 *
 * ABSENT ORIGIN IS ALWAYS REFUSED, ON EVERY ROUTE THIS GUARDS — deliberately
 * stricter than this module's own pre-FACTORY-465 history. Before this
 * change, the plain HTTP route (`checkBearerOrigin`) allowed a missing
 * `Origin` header through on a valid bearer token alone, because a browser
 * always sends `Origin` on a cross-origin `fetch()` and a non-browser caller
 * could instead prove itself with the token. With the token gone, `Origin`
 * is the ONLY credential left — an absent one no longer has anything to
 * fall back to, so it is refused here exactly like a present-but-unlisted
 * one. This also removes the need for a second, WebSocket-specific "strict"
 * variant: `checkExtensionOrigin` below now serves both the plain HTTP route
 * and the WebSocket-upgrade route (see `src/web/view.ts`) with the SAME
 * rule, because the ONLY reason they used to differ — the bearer token's
 * absent-Origin exception on the HTTP side — no longer exists.
 *
 * CORS response headers are emitted ONLY for an allowlisted origin, and
 * NEVER as `*`: this mechanism's whole point is that only a specific
 * extension id may read the response, so a wildcard would defeat that.
 */

export interface OriginGuardDeps {
  /** `chrome-extension://<id>` origins allowed to reach a guarded route. Empty/unset means every origin is rejected — fail-closed, never "no allowlist configured, so allow everything". */
  allowedOrigins: readonly string[];
}

export type GuardOutcome =
  | { ok: true; corsHeaders: Record<string, string> }
  | { ok: false; status: number; body: { error: string }; corsHeaders: Record<string, string> };

/** CORS headers for an ALLOWLISTED origin only — never call this for a disallowed or absent origin. */
function corsHeadersFor(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/**
 * The whole guard for a guarded route — both the plain HTTP route
 * (`GET /resources/for-url`) and the WebSocket upgrade route
 * (`GET /agents/:agentKey/pty`) — see this module's own header for why one
 * rule now covers both. `origin` is `null` when the header is absent — pass
 * `Request.headers.get("origin")` straight through. Never throws.
 */
export function checkExtensionOrigin(req: { origin: string | null }, deps: OriginGuardDeps): GuardOutcome {
  if (req.origin === null) {
    return { ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {} };
  }
  if (!deps.allowedOrigins.includes(req.origin)) {
    return { ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {} };
  }
  return { ok: true, corsHeaders: corsHeadersFor(req.origin) };
}

/**
 * The CORS preflight (`OPTIONS`) response for a route guarded by
 * `checkExtensionOrigin`.
 */
export function preflightExtensionOrigin(req: { origin: string | null }, deps: OriginGuardDeps): { status: number; headers: Record<string, string> } {
  if (req.origin === null || !deps.allowedOrigins.includes(req.origin)) return { status: 403, headers: {} };
  return {
    status: 204,
    headers: {
      ...corsHeadersFor(req.origin),
      "access-control-allow-methods": "GET, OPTIONS",
    },
  };
}

/** `chrome-extension://<32-char id>` — a real Chrome extension id is always exactly 32 lowercase letters `a`-`p` (base16 over that alphabet), never anything else. */
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/** True only for a well-formed `chrome-extension://<id>` origin — used to validate `BUTCHR_EXTENSION_ORIGINS` entries at config-load time, before any request is ever checked against them. */
export const isExtensionOrigin = (origin: string): boolean => EXTENSION_ORIGIN_RE.test(origin);
