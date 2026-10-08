import { describe, expect, test } from "bun:test";
import { checkWriteGuard, cappedReadText, BODY_CAP_BYTES, CSRF_HEADER } from "../../src/web/write-guard.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";

const PORT = 7718;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

const CLIENT = { address: "127.0.0.1", port: 54321 };

function baseReq(csrf: ReturnType<typeof createCsrfTokenIssuer>, overrides: Partial<Parameters<typeof checkWriteGuard>[0]> = {}) {
  return { origin: ORIGIN, host: HOST, method: "POST", contentType: "application/json", csrfHeader: csrf.token, client: CLIENT, ...overrides };
}

describe("checkWriteGuard", () => {
  test("every check passing: ok", async () => {
    const csrf = createCsrfTokenIssuer();
    const outcome = await checkWriteGuard(baseReq(csrf), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => true, csrf });
    expect(outcome.ok).toBe(true);
  });

  test("Origin check runs first: a forged origin is refused before peer-uid is even consulted", async () => {
    const csrf = createCsrfTokenIssuer();
    let peerChecked = false;
    const outcome = await checkWriteGuard(baseReq(csrf, { origin: "http://evil.example" }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => { peerChecked = true; return true; }, csrf });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(403);
    expect(peerChecked).toBe(false);
  });

  test("peer-uid rejects: 403, never reaches the content-type/csrf checks", async () => {
    const csrf = createCsrfTokenIssuer();
    const outcome = await checkWriteGuard(baseReq(csrf, { contentType: "text/plain", csrfHeader: "wrong" }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => false, csrf });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.status).toBe(403); expect(outcome.reason).toBe("peer uid check failed"); }
  });

  test("client undefined (could not resolve the real server): refused, same as a failed peer-uid check", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const outcome = await checkWriteGuard(baseReq(csrf, { client: undefined }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => { called = true; return true; }, csrf });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("wrong content-type: 415", async () => {
    const csrf = createCsrfTokenIssuer();
    const outcome = await checkWriteGuard(baseReq(csrf, { contentType: "text/plain" }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => true, csrf });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(415);
  });

  test("content-type with a charset suffix is still accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const outcome = await checkWriteGuard(baseReq(csrf, { contentType: "application/json; charset=utf-8" }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => true, csrf });
    expect(outcome.ok).toBe(true);
  });

  test("missing/wrong CSRF token: 403", async () => {
    const csrf = createCsrfTokenIssuer();
    const missing = await checkWriteGuard(baseReq(csrf, { csrfHeader: null }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => true, csrf });
    expect(missing.ok).toBe(false);
    const wrong = await checkWriteGuard(baseReq(csrf, { csrfHeader: "0".repeat(csrf.token.length) }), { dashboardOriginGuard: { port: PORT }, peerUidCheck: () => true, csrf });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.status).toBe(403);
  });
});

describe("cappedReadText", () => {
  function requestWithBody(text: string): Request {
    return new Request("http://local/x", { method: "POST", body: text });
  }

  test("a small body reads back exactly", async () => {
    const result = await cappedReadText(requestWithBody("hello"), BODY_CAP_BYTES);
    expect(result).toEqual({ ok: true, text: "hello" });
  });

  test("a body under the cap reads back exactly, byte for byte", async () => {
    const text = "x".repeat(BODY_CAP_BYTES - 1);
    const result = await cappedReadText(requestWithBody(text), BODY_CAP_BYTES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text.length).toBe(BODY_CAP_BYTES - 1);
  });

  test("a body over the cap is refused — never buffered in full", async () => {
    const text = "x".repeat(BODY_CAP_BYTES + 1);
    const result = await cappedReadText(requestWithBody(text), BODY_CAP_BYTES);
    expect(result).toEqual({ ok: false, tooLarge: true });
  });

  test("no body at all: reads as the empty string", async () => {
    const result = await cappedReadText(new Request("http://local/x", { method: "GET" }), BODY_CAP_BYTES);
    expect(result).toEqual({ ok: true, text: "" });
  });
});

void CSRF_HEADER; // re-export sanity: imported without error
