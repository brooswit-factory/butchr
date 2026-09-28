import { describe, expect, test } from "bun:test";
import {
  checkBearerOrigin,
  checkBearerOriginForUpgrade,
  extractSubprotocolBearer,
  isExtensionOrigin,
  isHttpTokenChars,
  preflightBearerOrigin,
  PTY_BEARER_SUBPROTOCOL_MARKER,
  type BearerOriginGuardDeps,
} from "../../src/web/bearer-origin-guard.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const deps: BearerOriginGuardDeps = { token: "s3cr3t", allowedOrigins: [ORIGIN] };

describe("checkBearerOrigin", () => {
  test("token unset disables the endpoint (503) regardless of headers", () => {
    const disabled: BearerOriginGuardDeps = { token: undefined, allowedOrigins: [ORIGIN] };
    const r = checkBearerOrigin({ authorization: `Bearer anything`, origin: ORIGIN }, disabled);
    expect(r).toEqual({ ok: false, status: 503, body: { error: "endpoint disabled: no token configured" }, corsHeaders: {} });
  });
  test("missing Authorization header is unauthorized (401)", () => {
    const r = checkBearerOrigin({ authorization: null, origin: null }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  test("wrong token is unauthorized (401)", () => {
    const r = checkBearerOrigin({ authorization: "Bearer wrong", origin: null }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  test("correct token with no Origin header succeeds with no CORS headers", () => {
    const r = checkBearerOrigin({ authorization: "Bearer s3cr3t", origin: null }, deps);
    expect(r).toEqual({ ok: true, corsHeaders: {} });
  });
  test("correct token from an allowlisted origin succeeds with CORS headers for exactly that origin, never *", () => {
    const r = checkBearerOrigin({ authorization: "Bearer s3cr3t", origin: ORIGIN }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.corsHeaders["access-control-allow-origin"]).toBe(ORIGIN);
      expect(r.corsHeaders["access-control-allow-origin"]).not.toBe("*");
    }
  });
  test("a non-allowlisted Origin is rejected (403) even with a correct token, and never leaks the token check", () => {
    const r = checkBearerOrigin({ authorization: "Bearer s3cr3t", origin: OTHER_ORIGIN }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {} });
  });
  test("no response ever carries a wildcard CORS origin", () => {
    for (const origin of [null, ORIGIN, OTHER_ORIGIN]) {
      for (const authorization of [null, "Bearer s3cr3t", "Bearer wrong"]) {
        const r = checkBearerOrigin({ authorization, origin }, deps);
        expect(r.corsHeaders["access-control-allow-origin"]).not.toBe("*");
      }
    }
  });
});

describe("checkBearerOriginForUpgrade", () => {
  // FACTORY-453 acceptance criterion, stated by the ticket as its own test:
  // an upgrade with a MISSING Origin must be rejected here even though
  // `checkBearerOrigin` (above) ALLOWS a missing Origin for the plain HTTP
  // sibling route — this is a distinct code path and a distinct bug class
  // from "wrong Origin", tested separately on purpose.
  test("a correct token with NO Origin header is REJECTED (403) — the corrected WebSocket-upgrade rule, opposite of checkBearerOrigin", () => {
    const r = checkBearerOriginForUpgrade({ authorization: "Bearer s3cr3t", origin: null }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {} });
  });
  test("a non-allowlisted Origin is still rejected (403), same as checkBearerOrigin", () => {
    const r = checkBearerOriginForUpgrade({ authorization: "Bearer s3cr3t", origin: OTHER_ORIGIN }, deps);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin not allowed" }, corsHeaders: {} });
  });
  test("token unset disables the endpoint (503) before Origin is even inspected", () => {
    const disabled: BearerOriginGuardDeps = { token: undefined, allowedOrigins: [ORIGIN] };
    const r = checkBearerOriginForUpgrade({ authorization: "Bearer anything", origin: null }, disabled);
    expect(r).toEqual({ ok: false, status: 503, body: { error: "endpoint disabled: no token configured" }, corsHeaders: {} });
  });
  test("missing Authorization from an allowlisted origin is still unauthorized (401)", () => {
    const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  test("wrong token from an allowlisted origin is still unauthorized (401)", () => {
    const r = checkBearerOriginForUpgrade({ authorization: "Bearer wrong", origin: ORIGIN }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  test("correct token from an allowlisted origin succeeds with CORS headers for exactly that origin", () => {
    const r = checkBearerOriginForUpgrade({ authorization: "Bearer s3cr3t", origin: ORIGIN }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.corsHeaders["access-control-allow-origin"]).toBe(ORIGIN);
  });

  // FACTORY-455 (implementing FACTORY-454): the subprotocol channel is only
  // ever consulted when `Authorization` is ABSENT — a browser has no other
  // way to authenticate this upgrade at all, so this is its whole path.
  describe("the Sec-WebSocket-Protocol bearer channel (FACTORY-455)", () => {
    test("a correct token via subprotocol, with Authorization absent, succeeds and echoes back ONLY the marker", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: `${PTY_BEARER_SUBPROTOCOL_MARKER}, s3cr3t` }, deps);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.selectedSubprotocol).toBe(PTY_BEARER_SUBPROTOCOL_MARKER);
        expect(r.selectedSubprotocol).not.toBe("s3cr3t");
        expect(r.corsHeaders["access-control-allow-origin"]).toBe(ORIGIN);
      }
    });
    test("a wrong token via subprotocol is unauthorized (401)", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: `${PTY_BEARER_SUBPROTOCOL_MARKER}, wrong` }, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(401);
    });
    test("no Authorization and no subprotocol at all is unauthorized (401), same as missing Authorization alone", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: null }, deps);
      expect(r).toEqual({ ok: false, status: 401, body: { error: "unauthorized" }, corsHeaders: {} });
    });
    test("a subprotocol list naming the wrong marker is treated as no credential (401), never matched loosely", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: "not-the-marker, s3cr3t" }, deps);
      expect(r).toEqual({ ok: false, status: 401, body: { error: "unauthorized" }, corsHeaders: {} });
    });
    test("a subprotocol list with only the marker and no credential is unauthorized (401)", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: PTY_BEARER_SUBPROTOCOL_MARKER }, deps);
      expect(r).toEqual({ ok: false, status: 401, body: { error: "unauthorized" }, corsHeaders: {} });
    });
    test("Authorization present takes priority — a subprotocol credential is never consulted, correct or not", () => {
      const r = checkBearerOriginForUpgrade({ authorization: "Bearer s3cr3t", origin: ORIGIN, subprotocol: `${PTY_BEARER_SUBPROTOCOL_MARKER}, totally-wrong` }, deps);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.selectedSubprotocol).toBeUndefined();
    });
    test("MISSING Origin is still 403 even with a valid subprotocol token — the same corrected upgrade rule, not bypassed by this channel", () => {
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: null, subprotocol: `${PTY_BEARER_SUBPROTOCOL_MARKER}, s3cr3t` }, deps);
      expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {} });
    });
    test("token unset is 503 regardless of subprotocol", () => {
      const disabled: BearerOriginGuardDeps = { token: undefined, allowedOrigins: [ORIGIN] };
      const r = checkBearerOriginForUpgrade({ authorization: null, origin: ORIGIN, subprotocol: `${PTY_BEARER_SUBPROTOCOL_MARKER}, s3cr3t` }, disabled);
      expect(r).toEqual({ ok: false, status: 503, body: { error: "endpoint disabled: no token configured" }, corsHeaders: {} });
    });
  });
});

describe("extractSubprotocolBearer", () => {
  test("extracts the credential from a well-formed [marker, credential] list", () => {
    expect(extractSubprotocolBearer("clevr.bearer, s3cr3t", "clevr.bearer")).toBe("s3cr3t");
  });
  test("tolerates the RFC 6455 comma-separated-with-optional-whitespace form exactly, nothing looser", () => {
    expect(extractSubprotocolBearer("clevr.bearer,s3cr3t", "clevr.bearer")).toBe("s3cr3t");
  });
  test("returns null for a null header", () => {
    expect(extractSubprotocolBearer(null, "clevr.bearer")).toBeNull();
  });
  test("returns null when the marker doesn't match", () => {
    expect(extractSubprotocolBearer("other.marker, s3cr3t", "clevr.bearer")).toBeNull();
  });
  test("returns null for too few or too many entries", () => {
    expect(extractSubprotocolBearer("clevr.bearer", "clevr.bearer")).toBeNull();
    expect(extractSubprotocolBearer("clevr.bearer, s3cr3t, extra", "clevr.bearer")).toBeNull();
  });
});

describe("isHttpTokenChars (FACTORY-455 charset decision for BUTCHR_EXTENSION_TOKEN)", () => {
  test("accepts common secret shapes: hex, base64url, JWT-like dotted segments", () => {
    expect(isHttpTokenChars("a1b2c3d4e5f6")).toBe(true);
    expect(isHttpTokenChars("aGVsbG8td29ybGQ-_")).toBe(true);
    expect(isHttpTokenChars("header.payload.signature")).toBe(true);
  });
  test("rejects whitespace, quotes, commas and other RFC 2616 separators", () => {
    for (const bad of ["has space", "has,comma", 'has"quote', "has/slash", "has;semi", "has:colon"]) {
      expect(isHttpTokenChars(bad)).toBe(false);
    }
  });
  test("rejects the empty string", () => {
    expect(isHttpTokenChars("")).toBe(false);
  });
});

describe("preflightBearerOrigin", () => {
  test("token unset disables preflight too (503)", () => {
    const disabled: BearerOriginGuardDeps = { token: undefined, allowedOrigins: [ORIGIN] };
    expect(preflightBearerOrigin({ origin: ORIGIN }, disabled)).toEqual({ status: 503, headers: {} });
  });
  test("missing or non-allowlisted Origin is refused (403), never bearer-checked", () => {
    expect(preflightBearerOrigin({ origin: null }, deps)).toEqual({ status: 403, headers: {} });
    expect(preflightBearerOrigin({ origin: OTHER_ORIGIN }, deps)).toEqual({ status: 403, headers: {} });
  });
  test("an allowlisted origin gets a 204 with CORS headers naming Authorization, never *", () => {
    const r = preflightBearerOrigin({ origin: ORIGIN }, deps);
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(r.headers["access-control-allow-headers"]).toContain("Authorization");
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
