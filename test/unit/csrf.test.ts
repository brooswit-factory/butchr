import { describe, expect, test } from "bun:test";
import { createCsrfTokenIssuer, CSRF_TOKEN_BYTES } from "../../src/web/csrf.js";

describe("createCsrfTokenIssuer", () => {
  test("mints a token of the documented length, hex-encoded", () => {
    const issuer = createCsrfTokenIssuer();
    expect(issuer.token).toMatch(/^[0-9a-f]+$/);
    expect(issuer.token.length).toBe(CSRF_TOKEN_BYTES * 2);
  });

  test("check: true for the exact live token", () => {
    const issuer = createCsrfTokenIssuer();
    expect(issuer.check(issuer.token)).toBe(true);
  });

  test("check: false for a wrong token, null, undefined, non-string, empty string", () => {
    const issuer = createCsrfTokenIssuer();
    expect(issuer.check("deadbeef")).toBe(false);
    expect(issuer.check(null)).toBe(false);
    expect(issuer.check(undefined)).toBe(false);
    expect(issuer.check("")).toBe(false);
    // a candidate the same length as the real token but wrong content
    expect(issuer.check("0".repeat(issuer.token.length))).toBe(false);
  });

  test("two issuers mint different tokens (randomness is real, not a fixture)", () => {
    const a = createCsrfTokenIssuer();
    const b = createCsrfTokenIssuer();
    expect(a.token).not.toBe(b.token);
  });
});
