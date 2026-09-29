import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import type { ResourcesForUrlResponse } from "../../src/resources/resource-lookup.js";

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

describe("existing routes are unaffected", () => {
  test("/health still works with no auth, unauthenticated by design", async () => {
    const app = liveView(fakeMcp, baseDeps({ health: () => ({ ok: true }) as any }));
    const res = await app.handle(new Request("http://local/health"));
    expect(res.status).toBe(200);
  });
});
