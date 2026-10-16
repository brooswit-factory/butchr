import { describe, expect, test } from "bun:test";
import { checkExtensionOrigin, isExtensionOrigin, preflightExtensionOrigin, type OriginGuardDeps } from "../../src/web/origin-guard.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const deps: OriginGuardDeps = { allowedOrigins: [ORIGIN] };

describe("checkExtensionOrigin", () => {
  test("missing Origin header is refused (403) — the only credential left, so absent means refused", () => {
    const r = checkExtensionOrigin({ origin: null }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {}, reason: "origin required" });
  });
  test("a non-allowlisted Origin is rejected (403)", () => {
    const r = checkExtensionOrigin({ origin: OTHER_ORIGIN }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {}, reason: "origin not allowed" });
  });
  test("an allowlisted origin succeeds with CORS headers for exactly that origin, never *", () => {
    const r = checkExtensionOrigin({ origin: ORIGIN }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.corsHeaders["access-control-allow-origin"]).toBe(ORIGIN);
      expect(r.corsHeaders["access-control-allow-origin"]).not.toBe("*");
    }
  });
  test("an empty allowlist rejects every origin, including one that would otherwise look plausible — fail-closed", () => {
    const empty: OriginGuardDeps = { allowedOrigins: [] };
    expect(checkExtensionOrigin({ origin: ORIGIN }, empty).ok).toBe(false);
    expect(checkExtensionOrigin({ origin: null }, empty).ok).toBe(false);
  });
  test("FACTORY-476: an empty allowlist with a present origin classifies as its own distinct reason, not the ordinary non-allowlisted-origin one — but the wire body's wording is unchanged", () => {
    const empty: OriginGuardDeps = { allowedOrigins: [] };
    const r = checkExtensionOrigin({ origin: ORIGIN }, empty);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {}, reason: "allowlist empty" });
  });
  test("FACTORY-476: an absent Origin against an empty allowlist is still classified as 'origin required', not 'allowlist empty' — the more specific fact wins", () => {
    const empty: OriginGuardDeps = { allowedOrigins: [] };
    const r = checkExtensionOrigin({ origin: null }, empty);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {}, reason: "origin required" });
  });
  test("no response ever carries a wildcard CORS origin", () => {
    for (const origin of [null, ORIGIN, OTHER_ORIGIN]) {
      const r = checkExtensionOrigin({ origin }, deps);
      expect(r.corsHeaders["access-control-allow-origin"]).not.toBe("*");
    }
  });
});

describe("preflightExtensionOrigin", () => {
  test("missing or non-allowlisted Origin is refused (403)", () => {
    expect(preflightExtensionOrigin({ origin: null }, deps)).toEqual({ status: 403, headers: {}, reason: "origin required" });
    expect(preflightExtensionOrigin({ origin: OTHER_ORIGIN }, deps)).toEqual({ status: 403, headers: {}, reason: "origin not allowed" });
  });
  test("an allowlisted origin gets a 204 with CORS headers, never a wildcard origin", () => {
    const r = preflightExtensionOrigin({ origin: ORIGIN }, deps);
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(r.headers["access-control-allow-origin"]).not.toBe("*");
  });
  test("an empty allowlist refuses even an origin shaped like a real extension id", () => {
    const empty: OriginGuardDeps = { allowedOrigins: [] };
    expect(preflightExtensionOrigin({ origin: ORIGIN }, empty)).toEqual({ status: 403, headers: {}, reason: "allowlist empty" });
  });
});

describe("isExtensionOrigin", () => {
  test("accepts the canonical 32-lowercase-a-p-letter form", () => {
    expect(isExtensionOrigin(ORIGIN)).toBe(true);
  });
  test("rejects non-chrome-extension schemes, wrong lengths, and out-of-alphabet characters", () => {
    for (const bad of ["https://abcdefghijklmnopabcdefghijklmnop", "chrome-extension://short", "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", "chrome-extension://abcdefghijklmnopabcdefghijklmno0", ""]) {
      expect(isExtensionOrigin(bad)).toBe(false);
    }
  });
});
