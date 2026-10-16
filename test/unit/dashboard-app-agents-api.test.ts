import { afterEach, describe, expect, test } from "bun:test";
import { realAgentsApi } from "../../dashboard-app/src/api/agents.js";
import { validateStopRequestBody, validateShelveRequestBody, validateAdoptRequestBody, validatePrioritizeRequestBody } from "../../src/agents/agents-write.js";

/**
 * FACTORY-666 (AC7) — the same cross-contract proof `dashboard-app-rules-
 * api.test.ts` already makes for `createRule`/`validateRuleCreateInput`:
 * the EXACT bytes the real client puts on the wire, fed straight into the
 * SAME validator function the real server route calls. This is the exact
 * failure mode that once shipped a route unreachable from the real UI — a
 * client/route body-shape mismatch caught by nothing but this kind of test.
 */
describe("realAgentsApi — FACTORY-666: wire bodies match the server's own validators", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureFetch(onCall: (url: string, init?: RequestInit) => Response) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return onCall(url, init);
    }) as unknown as typeof fetch;
  }

  test("stop(confirm: false)'s wire body is accepted by validateStopRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ requiresConfirm: true, confirmReason: "agent-stop", preview: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.stop("FACTORY-1", false);
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ confirm: false });
    const result = validateStopRequestBody(wireBody);
    expect(result).toEqual({ ok: true, confirm: false });
  });

  test("stop(confirm: true)'s wire body is accepted by validateStopRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.stop("FACTORY-1", true);
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ confirm: true });
    expect(validateStopRequestBody(wireBody)).toEqual({ ok: true, confirm: true });
  });

  test("shelve's wire body (reason + confirm) is accepted by validateShelveRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.shelve("FACTORY-1", "operator is stepping in manually", true);
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ reason: "operator is stepping in manually", confirm: true });
    const result = validateShelveRequestBody(wireBody);
    expect(result).toEqual({ ok: true, reason: "operator is stepping in manually", confirm: true });
  });

  test("adopt's wire body (disposition: start, no reason) is accepted by validateAdoptRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.adopt("FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "start" });
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ bossKey: "FACTORY-BOSS", disposition: "start" });
    const result = validateAdoptRequestBody(wireBody);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input).toEqual({ bossKey: "FACTORY-BOSS", disposition: "start" });
  });

  test("adopt's wire body (disposition: shelve, with reason) is accepted by validateAdoptRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.adopt("FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "orphan cleanup" });
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "orphan cleanup" });
    const result = validateAdoptRequestBody(wireBody);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input).toEqual({ bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "orphan cleanup" });
  });

  test("prioritize's wire body is accepted by validatePrioritizeRequestBody", async () => {
    let sentBody: string | undefined;
    captureFetch((_url, init) => { sentBody = String(init?.body); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); });
    await realAgentsApi.prioritize("FACTORY-1", "High");
    const wireBody = JSON.parse(sentBody!);
    expect(wireBody).toEqual({ priority: "High" });
    expect(validatePrioritizeRequestBody(wireBody)).toEqual({ ok: true, priority: "High" });
  });

  test("start sends an empty-object body (no fields to validate) and GETs the snapshot without CSRF", async () => {
    let sentBody: string | undefined;
    let sawCsrfOnGet = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/agents/FACTORY-1") {
        sawCsrfOnGet = (init?.headers as Record<string, string> | undefined)?.["x-butchr-csrf"] !== undefined;
        return new Response(JSON.stringify({ key: "FACTORY-1", status: "To Do", summary: "x", labels: [], boss: null, running: false, pane: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      sentBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await realAgentsApi.start("FACTORY-1");
    expect(JSON.parse(sentBody!)).toEqual({});
    await realAgentsApi.getSnapshot("FACTORY-1");
    expect(sawCsrfOnGet).toBe(false);
  });

  test("a server refusal's error message reaches the caller verbatim as the thrown Error's message (AC4)", async () => {
    captureFetch(() => new Response(JSON.stringify({ error: "FACTORY-1 has no boss (no Implements link and no eligible Jira parent) — adopt it first with a boss key before starting, shelving or prioritizing it" }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(realAgentsApi.start("FACTORY-1")).rejects.toThrow("FACTORY-1 has no boss (no Implements link and no eligible Jira parent) — adopt it first with a boss key before starting, shelving or prioritizing it");
  });
});
