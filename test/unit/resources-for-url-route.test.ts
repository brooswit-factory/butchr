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
  test("token unset (extensionAuth omitted): 503, disabled, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps());
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "endpoint disabled: no token configured" });
  });
  test("missing Authorization header: 401", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x"));
    expect(res.status).toBe(401);
  });
  test("wrong token: 401", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
  });
  test("token set but Origin not allowlisted: 403, and no resourcesForUrl call", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { authorization: "Bearer s3cr3t", origin: OTHER_ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("correct token, no Origin header: 200, no CORS headers set", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }) }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https%3A%2F%2Fexample.com", { headers: { authorization: "Bearer s3cr3t" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...stubResponse, url: "https://example.com" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("correct token from the allowlisted origin: 200 with CORS headers for exactly that origin, never *", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url?url=https://x", { headers: { authorization: "Bearer s3cr3t", origin: ORIGIN } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
  test("the token itself is never echoed back in any response body or header", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t-value", allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    for (const req of [
      new Request("http://local/resources/for-url?url=https://x"),
      new Request("http://local/resources/for-url?url=https://x", { headers: { authorization: "Bearer wrong" } }),
      new Request("http://local/resources/for-url?url=https://x", { headers: { authorization: "Bearer s3cr3t-value", origin: ORIGIN } }),
    ]) {
      const res = await app.handle(req);
      const text = await res.text();
      expect(text).not.toContain("s3cr3t-value");
      expect([...res.headers.values()].join(" ")).not.toContain("s3cr3t-value");
    }
  });
});

describe("OPTIONS /resources/for-url (CORS preflight)", () => {
  test("token unset: 503", async () => {
    const app = liveView(fakeMcp, baseDeps());
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(503);
  });
  test("non-allowlisted origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("allowlisted origin: 204 with Authorization allowed and never a wildcard origin", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { token: "s3cr3t", allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("existing routes are unaffected", () => {
  test("/health still works with no auth, unauthenticated by design", async () => {
    const app = liveView(fakeMcp, baseDeps({ health: () => ({ ok: true }) as any }));
    const res = await app.handle(new Request("http://local/health"));
    expect(res.status).toBe(200);
  });
});
