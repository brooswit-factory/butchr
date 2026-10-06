/**
 * FACTORY-660 (SPEC CHANGE (d), agentsafety review 2026-10-05) — the
 * dashboard's OWN Origin/Host guard, for `GET /api/rules` and
 * `GET /api/rules/:id/preview`. Deliberately NOT `./origin-guard.ts`'s
 * `checkExtensionOrigin`/`OriginGuardDeps`: that mechanism is an allowlist
 * of EXTERNAL `chrome-extension://` origins the operator opts in; this
 * dashboard is this daemon's OWN first-party page, served from this same
 * process on loopback, so its guard checks the request actually came from
 * that page's own origin — `http://127.0.0.1:<port>` or
 * `http://localhost:<port>` — never a configurable allowlist, and never
 * added to the extension allowlist.
 *
 * PR #642 review round 1 (manager-factory, 2026-10-05): the original
 * version refused EVERY absent `Origin`, which refuses a REAL browser's own
 * same-origin GET too — the Fetch spec only stamps `Origin` on a
 * non-GET/HEAD request, or a cross-origin one, so a plain
 * `fetch("/api/rules")` from the dashboard page itself carries no `Origin`
 * at all. Fixed: for a GET/HEAD request, an absent `Origin` is accepted
 * when `Sec-Fetch-Site: same-origin` is present AND `Host` exactly matches
 * one of this daemon's own allowed hosts — `Sec-Fetch-Site` is a
 * browser-set, unspoofable-by-a-page fetch-metadata header (unlike
 * `Origin`, which a page CAN omit by not setting `Origin`, this header is
 * never under page-script control at all) naming exactly this same-origin
 * case. A present `Origin` still goes through the exact-match + exact-`Host`
 * check unchanged. WRITE methods (POST et al, FACTORY-662's slice) get NO
 * such fallback: a real browser's `fetch` always stamps `Origin` on a
 * non-GET/HEAD request, so "absent Origin" on a write is never the genuine
 * same-origin case and stays refused outright — same discipline as before,
 * now scoped to where it was always actually true.
 *
 * FAIL CLOSED otherwise: a present-but-unlisted `Origin`, a `Host` that
 * doesn't match what `Origin` (or the fallback) claims, or a GET/HEAD with
 * no `Origin` and no (or a non-`same-origin`) `Sec-Fetch-Site` are all
 * refused — never "no browser fetch, so skip the check".
 */

export interface DashboardOriginGuardDeps {
  /** This daemon's own listening port — the only port an `Origin`/`Host` pair may name. */
  port: number;
}

export type DashboardGuardRejectReason = "origin required" | "origin not allowed" | "host mismatch";

export type DashboardGuardOutcome =
  | { ok: true }
  | { ok: false; status: number; body: { error: string }; reason: DashboardGuardRejectReason };

/** The two, and only two, hosts this daemon's own dashboard page can legitimately claim to be. */
function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export interface DashboardOriginGuardRequest {
  origin: string | null;
  host: string | null;
  /** `Request.headers.get("sec-fetch-site")` — `null` when absent (a non-fetch-metadata-sending client; refused the same as any other missing credential on the no-Origin path). */
  secFetchSite?: string | null;
  /** HTTP method, case-insensitive. Defaults to `"GET"` — every CURRENT caller of this guard is a GET route. The no-Origin/`Sec-Fetch-Site: same-origin` fallback applies ONLY to GET/HEAD; pass the real method once a write route (FACTORY-662) reuses this guard, so that fallback never silently covers a write. */
  method?: string;
}

/**
 * `origin`/`host`/`secFetchSite` are `Request.headers.get(...)`, passed
 * straight through (`null` when absent). Never throws.
 */
export function checkDashboardOrigin(req: DashboardOriginGuardRequest, deps: DashboardOriginGuardDeps): DashboardGuardOutcome {
  const hosts = allowedHosts(deps.port);
  const method = (req.method ?? "GET").toUpperCase();

  if (req.origin !== null) {
    const matchedHost = hosts.find((h) => req.origin === `http://${h}`);
    if (!matchedHost) return { ok: false, status: 403, body: { error: "origin not allowed" }, reason: "origin not allowed" };
    if (req.host !== matchedHost) return { ok: false, status: 403, body: { error: "origin not allowed" }, reason: "host mismatch" };
    return { ok: true };
  }

  // No Origin: the genuine same-origin-GET case, or an attempt with no
  // credential at all — told apart by Sec-Fetch-Site, never assumed.
  if ((method === "GET" || method === "HEAD") && req.secFetchSite === "same-origin" && req.host !== null && hosts.includes(req.host)) {
    return { ok: true };
  }
  return { ok: false, status: 403, body: { error: "origin required" }, reason: "origin required" };
}
