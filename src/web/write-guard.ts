/**
 * FACTORY-662 — the ONE trust model every config-write route in this daemon
 * runs through, before any write-specific logic. Reuses, never re-derives:
 * `checkDashboardOrigin` (FACTORY-660, this daemon's own loopback origin),
 * `isSameUidPeer` (FACTORY-660, same-UID peer check), `CsrfTokenIssuer`
 * (`./csrf.ts`, this ticket). A route-specific handler is reached only after
 * EVERY check below passes — same "guards first" discipline `view.ts`
 * already documents for the read-only preview route, extended here to
 * writes: Origin, Host, peer-uid, Content-Type, and the CSRF token, all
 * checked from HEADERS ALONE, before this daemon ever reads or parses a
 * byte of the request body (the body itself is capped and parsed by
 * `view.ts`'s own `onParse` hook — see that module for why the cap lives
 * there instead of here).
 *
 * ORDER MATTERS, and is fixed: Origin/Host (cheapest, and the one check a
 * forged request is least likely to pass), THEN peer-uid (a `/proc` read),
 * THEN Content-Type, THEN the CSRF token (reads the header the attacker is
 * least likely to have, so it's checked last — not because it matters less,
 * but so a request that already fails an earlier, cheaper check never pays
 * for a `timingSafeEqual` call it was always going to fail anyway).
 */
import { checkDashboardOrigin, type DashboardOriginGuardDeps } from "./dashboard-origin-guard.js";
import { CSRF_HEADER, type CsrfTokenIssuer } from "./csrf.js";

export type WriteGuardRejectReason =
  | "origin required" | "origin not allowed" | "host mismatch"
  | "peer uid check failed"
  | "content-type must be application/json"
  | "csrf token missing or invalid";

export type WriteGuardOutcome =
  | { ok: true }
  | { ok: false; status: number; body: { error: string }; reason: WriteGuardRejectReason };

export interface SocketEndpoint {
  address: string;
  port: number;
}

export interface WriteGuardDeps {
  dashboardOriginGuard: DashboardOriginGuardDeps;
  /** `null`/`undefined` fails closed (as `isSameUidPeer` itself does on anything unresolvable) — see `ViewDeps.peerUidCheck`'s own doc comment for why this is a function of the client's own socket endpoint, not a fixed value. */
  peerUidCheck: (client: SocketEndpoint) => boolean;
  csrf: CsrfTokenIssuer;
}

export interface WriteGuardRequest {
  origin: string | null;
  host: string | null;
  /** The caller's own HTTP method (e.g. `"POST"`, `"PUT"`) — passed through to `checkDashboardOrigin` explicitly; see that function's own doc comment for why a write route must never leave this implicit. */
  method: string;
  contentType: string | null;
  csrfHeader: string | null;
  /** `undefined` when the real Bun `server` was unavailable to resolve it (e.g. `app.handle()` in a test with no listening server), or `server.requestIP(request)` itself returned `null` — both treated the same as "could not resolve", i.e. refused. */
  client: SocketEndpoint | undefined;
}

export function checkWriteGuard(req: WriteGuardRequest, deps: WriteGuardDeps): WriteGuardOutcome {
  const originGuard = checkDashboardOrigin({ origin: req.origin, host: req.host, method: req.method }, deps.dashboardOriginGuard);
  if (!originGuard.ok) return { ok: false, status: originGuard.status, body: originGuard.body, reason: originGuard.reason };

  if (req.client === undefined || !deps.peerUidCheck(req.client)) {
    return { ok: false, status: 403, body: { error: "peer uid check failed" }, reason: "peer uid check failed" };
  }

  // `Content-Type: application/json` exactly (ignoring an optional
  // `; charset=...` suffix a correct JSON client may still send) — never
  // `text/plain`, `multipart/form-data`, or absent.
  const contentType = (req.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, body: { error: "content-type must be application/json" }, reason: "content-type must be application/json" };
  }

  if (!deps.csrf.check(req.csrfHeader)) {
    return { ok: false, status: 403, body: { error: "csrf token missing or invalid" }, reason: "csrf token missing or invalid" };
  }

  return { ok: true };
}

/** `${CSRF_HEADER}` re-exported so a caller building `WriteGuardRequest` from real headers doesn't need a second import. */
export { CSRF_HEADER };

/**
 * Item 3 of the ship gate: 64 KB, enforced by actually counting bytes off
 * the stream — NEVER by trusting `Content-Length` alone (a forged or
 * absent header must not let an oversized body through). Checked in
 * `view.ts`'s `onParse` hook, which per Elysia's own lifecycle runs AFTER
 * `onRequest` (where Origin/Host/peer-uid/Content-Type/CSRF are checked) —
 * so a request already refused by those never reaches this read at all,
 * which is what makes "a 10 MB body from a forbidden Origin never costs
 * this daemon a 10 MB read" true.
 */
export const BODY_CAP_BYTES = 64 * 1024;

export type CappedReadResult = { ok: true; text: string } | { ok: false; tooLarge: true };

/** Reads `request`'s body up to `capBytes` + 1, cancelling the stream the moment it's exceeded rather than buffering past the cap. */
export async function cappedReadText(request: Request, capBytes: number): Promise<CappedReadResult> {
  const body = request.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > capBytes) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel/done */ }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return { ok: true, text: Buffer.from(merged).toString("utf8") };
}
