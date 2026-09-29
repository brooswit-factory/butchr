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

/**
 * FACTORY-476: the three ways this guard refuses a request, told apart —
 * a bare 403 in the journal can't distinguish "no Origin sent at all" from
 * "sent one, but it's not on the list" from "the list itself is empty" (an
 * operator misconfiguration, not a caller mistake). `checkExtensionOrigin`
 * and `preflightExtensionOrigin` both classify with the SAME precedence
 * (`classifyOrigin` below) so a caller logging this never has to reconcile
 * two different orderings. This is a NEW, finer-grained signal for the
 * logger `src/web/origin-guard-log.ts` adds on top of this guard — it does
 * NOT change `GuardOutcome.body.error`'s wording, which stays exactly what
 * it was before this ticket (an empty allowlist and a non-allowlisted
 * origin both still say "origin not allowed" on the wire).
 */
export type GuardRejectReason = "origin required" | "origin not allowed" | "allowlist empty";

export type GuardOutcome =
  | { ok: true; corsHeaders: Record<string, string> }
  | { ok: false; status: number; body: { error: string }; corsHeaders: Record<string, string>; reason: GuardRejectReason };

/** CORS headers for an ALLOWLISTED origin only — never call this for a disallowed or absent origin. */
function corsHeadersFor(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/**
 * Shared classification behind both `checkExtensionOrigin` and
 * `preflightExtensionOrigin` — `null` means "allowed", anything else is the
 * specific reason it isn't. Order is deliberate: an absent Origin is always
 * "origin required" even when the allowlist is also empty (there is nothing
 * to compare it against either way, but "no credential offered" is the more
 * specific, more actionable fact); an empty allowlist is checked before the
 * membership test so a present-but-unlisted origin against a genuinely empty
 * list reads as the operator-misconfiguration case, not an ordinary mismatch.
 */
function classifyOrigin(origin: string | null, deps: OriginGuardDeps): GuardRejectReason | null {
  if (origin === null) return "origin required";
  if (deps.allowedOrigins.length === 0) return "allowlist empty";
  if (!deps.allowedOrigins.includes(origin)) return "origin not allowed";
  return null;
}

/**
 * The whole guard for a guarded route — the plain HTTP routes
 * (`GET`/`POST /resources/for-url`, FACTORY-480 added the POST) and the
 * WebSocket upgrade route (`GET /agents/:agentKey/pty`) — see this module's
 * own header for why one rule now covers both. `origin` is `null` when the
 * header is absent — pass `Request.headers.get("origin")` straight through.
 * Never throws.
 */
export function checkExtensionOrigin(req: { origin: string | null }, deps: OriginGuardDeps): GuardOutcome {
  const reason = classifyOrigin(req.origin, deps);
  if (reason !== null) {
    // `body.error` deliberately does NOT vary between "allowlist empty" and
    // "origin not allowed" — see `GuardRejectReason`'s own doc comment.
    return { ok: false, status: 403, body: { error: reason === "origin required" ? "origin required" : "origin not allowed" }, corsHeaders: {}, reason };
  }
  return { ok: true, corsHeaders: corsHeadersFor(req.origin!) };
}

/**
 * The CORS preflight (`OPTIONS`) response for a route guarded by
 * `checkExtensionOrigin`. `reason` is present only on refusal — same
 * classification as `checkExtensionOrigin`, exposed here so a caller can log
 * the OPTIONS rejection too, the same way it logs the GET one.
 */
export function preflightExtensionOrigin(req: { origin: string | null }, deps: OriginGuardDeps): { status: number; headers: Record<string, string>; reason?: GuardRejectReason } {
  const reason = classifyOrigin(req.origin, deps);
  if (reason !== null) return { status: 403, headers: {}, reason };
  return {
    status: 204,
    headers: {
      ...corsHeadersFor(req.origin!),
      // FACTORY-480: `POST /resources/for-url` carries a JSON body
      // (`content-type: application/json`, not a CORS-safelisted value for
      // that header), which is why a POST here triggers a preflight at all —
      // `access-control-allow-headers` must list it or the browser blocks
      // the actual request after a successful preflight.
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  };
}

/** `chrome-extension://<32-char id>` — a real Chrome extension id is always exactly 32 lowercase letters `a`-`p` (base16 over that alphabet), never anything else. */
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/** True only for a well-formed `chrome-extension://<id>` origin. */
export const isExtensionOrigin = (origin: string): boolean => EXTENSION_ORIGIN_RE.test(origin);
