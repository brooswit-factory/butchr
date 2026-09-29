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

// FACTORY-480: the route Clevr's extension service worker actually uses —
// see src/web/view.ts's own comment for why the GET above is unusable from
// that context (Chrome sends no Origin on a service-worker GET) and why the
// GET route above is kept unchanged regardless.
describe("POST /resources/for-url", () => {
  test("extensionAuth omitted (empty allowlist): 403, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(403);
  });
  test("missing Origin header: 403, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin required" });
  });
  test("Origin not allowlisted: 403, and no resourcesForUrl call", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => stubResponse }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: OTHER_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin not allowed" });
  });
  test("allowlisted origin: 200 with CORS headers for exactly that origin, never *, url read from JSON body", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }) }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...stubResponse, url: "https://example.com" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
  test("missing/non-string url in body: treated as empty string, same as the GET route's absent query.url", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }) }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toBe("");
  });
  // FACTORY-487: an allowlisted-origin request with the wrong (or missing)
  // content-type used to silently fall through to the "no url" empty-string
  // case instead of being refused — Elysia only parses `body` when it
  // recognizes the content-type, so a mismatched one just left `body`
  // unparsed, indistinguishable from a JSON body with no `url` field.
  test("wrong content-type: 415, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => { throw new Error("must not be called"); } }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "content-type must be application/json" });
  });
  test("missing content-type: 415, never calls resourcesForUrl", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => { throw new Error("must not be called"); } }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(415);
  });
  test("content-type with a charset suffix is still accepted (200)", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async (url) => ({ ...stubResponse, url }) }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ url: "https://example.com" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toBe("https://example.com");
  });
  // Elysia itself only recognizes the exact-case media type as JSON (measured:
  // it leaves `body` unparsed for `Application/JSON`) — this route's own
  // content-type check is matched to that, case-sensitively, on purpose, so
  // it never reports 200 on a request Elysia didn't actually parse as JSON.
  test("differently-cased media type: 415, not silently treated as JSON", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => { throw new Error("must not be called"); } }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "Application/JSON" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(415);
  });
  test("non-allowlisted origin with wrong content-type: still 403 — Origin guard runs first", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] }, resourcesForUrl: async () => { throw new Error("must not be called"); } }));
    const res = await app.handle(new Request("http://local/resources/for-url", {
      method: "POST", headers: { origin: OTHER_ORIGIN, "content-type": "text/plain" }, body: JSON.stringify({ url: "https://x" }),
    }));
    expect(res.status).toBe(403);
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
  // FACTORY-480: a JSON-body POST triggers a real preflight (content-type:
  // application/json isn't a CORS-safelisted header value), so the
  // preflight response must advertise POST and content-type or the browser
  // blocks the actual POST after a "successful" preflight.
  test("allowlisted origin: advertises POST alongside GET, and content-type in allow-headers", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: { allowedOrigins: [ORIGIN] } }));
    const res = await app.handle(new Request("http://local/resources/for-url", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
  });
});

describe("existing routes are unaffected", () => {
  test("/health still works with no auth, unauthenticated by design", async () => {
    const app = liveView(fakeMcp, baseDeps({ health: () => ({ ok: true }) as any }));
    const res = await app.handle(new Request("http://local/health"));
    expect(res.status).toBe(200);
  });
});
