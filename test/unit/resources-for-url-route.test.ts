import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import type { ResourcesForUrlResponse } from "../../src/resources/resource-lookup.js";
import { createOriginGuardLogger } from "../../src/web/origin-guard-log.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

const stubResponse: ResourcesForUrlResponse = { url: "https://x", canonicalUrl: "https://x/", resource: null, agents: [] };

/** The minimum `ViewDeps` this route's own handler ever touches — every other field is unused by these tests and left `undefined`/thrown to prove that. */
function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

describe("GET /resources/for-url", () => {
  test("extensionAuth omitted (empty allowlist): 403, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { origin: ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("missing Origin header: 403, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin required" });
  });
  test("Origin not allowlisted: 403, and no resourcesForUrl call", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { origin: OTHER_ORIGIN } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin not allowed" });
  });
  test("allowlisted origin: 200 with CORS headers for exactly that origin, never *, and no token required anywhere", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }) }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https%3A%2F%2Fexample.com", { headers: { origin: ORIGIN } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...stubResponse, url: "https://example.com" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("OPTIONS /resources/for-url (CORS preflight)", () => {
  test("extensionAuth omitted (empty allowlist): 403", async () => {
    const app = liveView(fakeMcp, baseDeps());
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("non-allowlisted origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("missing origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS" }));
    expect(res.status).toBe(403);
  });
  test("allowlisted origin: 204, never a wildcard origin", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("FACTORY-476: guard rejections on /resources/for-url are logged, allowed requests are not", () => {
  test("GET missing Origin: one line, path without the query string, origin 'absent', result 'origin required'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse, originGuardLog }));
    await app.handle(new Request("http://local/resources/for-url?url=https%3A%2F%2Fsecret.example%2Fpage"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("method=GET");
    expect(lines[0]).toContain("path=/resources/for-url");
    expect(lines[0]).toContain("origin=absent");
    expect(lines[0]).toContain("result=origin required");
    expect(lines[0]).not.toContain("secret.example");
    expect(lines[0]).not.toContain("?");
  });
  test("GET non-allowlisted origin: one line, origin verbatim, result 'origin not allowed'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse, originGuardLog }));
    await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { origin: OTHER_ORIGIN } }));
    expect(lines).toEqual([expect.stringContaining(`origin=${OTHER_ORIGIN} result=origin not allowed`)]);
  });
  test("GET with an empty allowlist and a well-formed origin: result 'allowlist empty'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ resourcesForUrl: async () => stubResponse, originGuardLog }));
    await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { origin: ORIGIN } }));
    expect(lines).toEqual([expect.stringContaining("result=allowlist empty")]);
  });
  test("OPTIONS preflight rejection is also logged, with method=OPTIONS", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, originGuardLog }));
    await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } }));
    expect(lines).toEqual([expect.stringContaining("method=OPTIONS")]);
  });
  test("an allowed GET logs nothing", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }), originGuardLog }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { origin: ORIGIN } }));
    expect(res.status).toBe(200);
    expect(lines).toEqual([]);
  });
  test("an allowed OPTIONS preflight logs nothing", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, originGuardLog }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(204);
    expect(lines).toEqual([]);
  });
  test("a repeated rejection within the dedupe window logs only once", async () => {
    const lines: string[] = [];
    let t = 0;
    const originGuardLog = createOriginGuardLogger({ now: () => t, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse, originGuardLog }));
    const req = () => new Request("http://local/resources/for-url?url=https://x", { headers: { origin: OTHER_ORIGIN } });
    await app.handle(req());
    t += 1_000;
    await app.handle(req());
    expect(lines.length).toBe(1);
  });
});

describe("existing routes are unaffected", () => {
  test("/health still works with no auth, unauthenticated by design", async () => {
    const app = liveView(fakeMcp, baseDeps({ health: () => ({ ok: true }) as any }));
    const res = await app.handle(new Request("http://local/health"));
    expect(res.status).toBe(200);
  });
});
