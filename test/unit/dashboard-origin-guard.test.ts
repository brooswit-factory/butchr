import { describe, expect, test } from "bun:test";
import { checkDashboardOrigin, type DashboardOriginGuardDeps } from "../../src/web/dashboard-origin-guard.js";

const deps: DashboardOriginGuardDeps = { port: 7718 };

describe("checkDashboardOrigin", () => {
  test("missing Origin is refused (403) — fail closed", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718" }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, reason: "origin required" });
  });
  test("a well-formed but wrong-port Origin is rejected", () => {
    const r = checkDashboardOrigin({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:7718" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("origin not allowed");
  });
  test("a non-loopback Origin is rejected even if the port matches", () => {
    const r = checkDashboardOrigin({ origin: "http://evil.example:7718", host: "127.0.0.1:7718" }, deps);
    expect(r.ok).toBe(false);
  });
  test("https Origin is rejected — this daemon serves plain http only", () => {
    const r = checkDashboardOrigin({ origin: "https://127.0.0.1:7718", host: "127.0.0.1:7718" }, deps);
    expect(r.ok).toBe(false);
  });
  test("127.0.0.1 Origin with the matching exact Host succeeds", () => {
    const r = checkDashboardOrigin({ origin: "http://127.0.0.1:7718", host: "127.0.0.1:7718" }, deps);
    expect(r.ok).toBe(true);
  });
  test("localhost Origin with the matching exact Host succeeds", () => {
    const r = checkDashboardOrigin({ origin: "http://localhost:7718", host: "localhost:7718" }, deps);
    expect(r.ok).toBe(true);
  });
  test("Origin says 127.0.0.1 but Host says localhost (or vice versa): refused — Host must match Origin exactly, not just be SOME allowed host", () => {
    const r1 = checkDashboardOrigin({ origin: "http://127.0.0.1:7718", host: "localhost:7718" }, deps);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("host mismatch");
    const r2 = checkDashboardOrigin({ origin: "http://localhost:7718", host: "127.0.0.1:7718" }, deps);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("host mismatch");
  });
  test("missing Host header with an otherwise-allowed Origin: refused", () => {
    const r = checkDashboardOrigin({ origin: "http://127.0.0.1:7718", host: null }, deps);
    expect(r.ok).toBe(false);
  });
});

// PR #642 review round 1: a real browser's own same-origin GET never
// carries Origin at all (Fetch spec stamps it only for non-GET/HEAD, or a
// cross-origin request) — the fallback below is what makes that real case
// pass without ever accepting a forgeable "no Origin, trust me" request.
describe("checkDashboardOrigin — GET/HEAD same-origin fallback (no Origin + Sec-Fetch-Site: same-origin)", () => {
  test("no Origin + Sec-Fetch-Site: same-origin + exact Host: passes", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "same-origin" }, deps);
    expect(r.ok).toBe(true);
  });
  test("no Origin + Sec-Fetch-Site: same-origin + exact localhost Host: passes", () => {
    const r = checkDashboardOrigin({ origin: null, host: "localhost:7718", secFetchSite: "same-origin" }, deps);
    expect(r.ok).toBe(true);
  });
  test("no Origin and no Sec-Fetch-Site at all: refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("origin required");
  });
  test("no Origin and Sec-Fetch-Site: cross-site: refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "cross-site" }, deps);
    expect(r.ok).toBe(false);
  });
  test("no Origin and Sec-Fetch-Site: same-site (not same-origin): refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "same-site" }, deps);
    expect(r.ok).toBe(false);
  });
  test("no Origin and Sec-Fetch-Site: none: refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "none" }, deps);
    expect(r.ok).toBe(false);
  });
  test("no Origin + Sec-Fetch-Site: same-origin but WRONG Host: refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:9999", secFetchSite: "same-origin" }, deps);
    expect(r.ok).toBe(false);
  });
  test("no Origin + Sec-Fetch-Site: same-origin but no Host at all: refused", () => {
    const r = checkDashboardOrigin({ origin: null, host: null, secFetchSite: "same-origin" }, deps);
    expect(r.ok).toBe(false);
  });
  test("the fallback applies to HEAD too", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "same-origin", method: "head" }, deps);
    expect(r.ok).toBe(true);
  });
  test("the fallback does NOT apply to POST — a write method with no Origin stays refused even with Sec-Fetch-Site: same-origin", () => {
    const r = checkDashboardOrigin({ origin: null, host: "127.0.0.1:7718", secFetchSite: "same-origin", method: "POST" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("origin required");
  });
  test("a present Origin on a GET still goes through the ordinary exact-match path, fallback or not", () => {
    const r = checkDashboardOrigin({ origin: "http://evil.example", host: "127.0.0.1:7718", secFetchSite: "same-origin" }, deps);
    expect(r.ok).toBe(false);
  });
});
