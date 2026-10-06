import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import type { SettingsApiResponse } from "../../src/web/settings-api.js";
import type { JiraTestResult } from "../../src/web/jira-connection-test.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

const PORT = 7719;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

const emptySettings: SettingsApiResponse = {
  settings: [],
  atlassianTokenFile: { key: "ATLASSIAN_TOKEN_FILE", path: null, source: "default", restartNeeded: true, secret: false, description: "x", exists: false, readable: false, mode: null, tooOpen: null },
};

function startApp(deps: Partial<ViewDeps> & { dashboardOriginGuard?: { port: number } } = {}) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = app.server?.port ?? 0;
  if (deps.dashboardOriginGuard) deps.dashboardOriginGuard.port = port;
  return { app, port, headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } };
}

describe("GET /api/settings", () => {
  test("no dashboardOriginGuard: 503, never calls settings()", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ settings: async () => { called = true; return emptySettings; } }));
    const res = await app.handle(new Request("http://local/api/settings", { headers: { origin: ORIGIN, host: HOST } }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("missing Origin: 403, never reaches peer-uid check or settings()", async () => {
    let checked = false;
    let called = false;
    const app = liveView(fakeMcp, baseDeps({
      dashboardOriginGuard: { port: PORT },
      peerUidCheck: () => { checked = true; return true; },
      settings: async () => { called = true; return emptySettings; },
    }));
    const res = await app.handle(new Request("http://local/api/settings", { headers: { host: HOST } }));
    expect(res.status).toBe(403);
    expect(checked).toBe(false);
    expect(called).toBe(false);
  });

  test("wrong Origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
    const res = await app.handle(new Request("http://local/api/settings", { headers: { origin: "http://evil.example", host: HOST } }));
    expect(res.status).toBe(403);
  });

  test("wrong Host (with a matching-looking Origin otherwise): 403", async () => {
    const guard = { port: 0 };
    const { app, port } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => true, settings: async () => emptySettings });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { origin: `http://127.0.0.1:${port}`, host: "127.0.0.1:9999" } });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("allowed origin, no peerUidCheck configured: 503, never reaches settings()", async () => {
    let called = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, settings: async () => { called = true; return emptySettings; } });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      expect(res.status).toBe(503);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck rejects: 403, never reaches settings()", async () => {
    let called = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => false, settings: async () => { called = true; return emptySettings; } });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "peer uid check failed" });
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("a local user with a different uid on the loopback socket is refused (same-UID peer check)", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, peerUidCheck: (client) => { expect(typeof client.address).toBe("string"); expect(typeof client.port).toBe("number"); return false; }, settings: async () => emptySettings });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck passes but no settings dep configured: 503", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => true });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: 200, Cache-Control: no-store, exact body from settings()", async () => {
    const guard = { port: 0 };
    const body: SettingsApiResponse = {
      settings: [{ key: "BUTCHR_PORT", value: "7717", source: "environment", restartNeeded: true, secret: false, description: "d" }],
      atlassianTokenFile: emptySettings.atlassianTokenFile,
    };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => true, settings: async () => body });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(body);
    } finally { await app.stop(true); }
  });

  test("a token value present in config never appears anywhere in the response body", async () => {
    const guard = { port: 0 };
    const leakSentinel = "sentinel-secret-should-never-leak";
    const body: SettingsApiResponse = {
      settings: [{ key: "ATLASSIAN_TOKEN", set: true, source: "environment", restartNeeded: true, secret: true, description: "d" }],
      atlassianTokenFile: emptySettings.atlassianTokenFile,
    };
    const { app, headers } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => true, settings: async () => body });
    try {
      const res = await fetch(`${headers.origin}/api/settings`, { headers });
      const text = await res.text();
      expect(text).not.toContain(leakSentinel);
      expect(JSON.parse(text).settings[0].value).toBeUndefined();
    } finally { await app.stop(true); }
  });

  test("real-browser same-origin case (no Origin, Sec-Fetch-Site: same-origin, exact Host): 200", async () => {
    const guard = { port: 0 };
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: guard, peerUidCheck: () => true, settings: async () => emptySettings }));
    app.listen(0);
    const port = app.server?.port ?? 0;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      expect(res.status).toBe(200);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/settings/jira/test", () => {
  const ok: JiraTestResult = { ok: true, site: "https://x.atlassian.net", httpStatusClass: "2xx" };

  function writeDeps(overrides: Partial<ViewDeps> = {}) {
    const csrf = createCsrfTokenIssuer();
    const guard = { port: 0 };
    const peerUidCheck = () => true;
    return { csrf, writeGuard: { dashboardOriginGuard: guard, peerUidCheck, csrf }, dashboardOriginGuard: guard, peerUidCheck, ...overrides };
  }

  test("no writeGuard configured: 503, never calls jiraTest()", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ jiraTest: async () => { called = true; return ok; } }));
    const res = await app.handle(new Request("http://local/api/settings/jira/test", { method: "POST", headers: { origin: ORIGIN, host: HOST, "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("missing Origin: 403, never reaches jiraTest()", async () => {
    let called = false;
    const deps = writeDeps({ jiraTest: async () => { called = true; return ok; } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong Host: 403", async () => {
    const deps = writeDeps();
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: "127.0.0.1:1", "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("another local uid (peer-uid check fails): 403, never reaches jiraTest()", async () => {
    let called = false;
    const deps = writeDeps({ peerUidCheck: () => false, jiraTest: async () => { called = true; return ok; } });
    deps.writeGuard.peerUidCheck = () => false;
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("no CSRF header: 403, never reaches jiraTest()", async () => {
    let called = false;
    const deps = writeDeps({ jiraTest: async () => { called = true; return ok; } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("valid CSRF + all guards pass, no jiraTest dep: 503", async () => {
    const deps = writeDeps();
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": csrfToken }, body: "{}" });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("valid CSRF, jiraTest configured: 200 with the exact fixed shape, audited", async () => {
    const audited: Array<{ outcome: string }> = [];
    const deps = writeDeps({ jiraTest: async () => ok, auditWrite: (e) => { audited.push(e); } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": csrfToken }, body: "{}" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ok);
      expect(audited).toHaveLength(1);
      expect(audited[0]!.outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("never echoes the request body or any secret back in the response", async () => {
    const deps = writeDeps({ jiraTest: async () => ok });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": csrfToken }, body: JSON.stringify({ somethingSecret: "should-not-echo" }) });
      const text = await res.text();
      expect(text).not.toContain("should-not-echo");
    } finally { await app.stop(true); }
  });

  test("rate limit: second call within 5s is refused with 429 and Retry-After, never calls jiraTest() again", async () => {
    let calls = 0;
    const jiraTestRateLimit = (() => {
      let used = false;
      return (_key: string) => {
        if (used) return { ok: false as const, retryAfterSeconds: 5 };
        used = true;
        return { ok: true as const };
      };
    })();
    const deps = writeDeps({ jiraTest: async () => { calls++; return ok; }, jiraTestRateLimit });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": csrfToken };
      const res1 = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers, body: "{}" });
      expect(res1.status).toBe(200);
      const res2 = await fetch(`http://127.0.0.1:${port}/api/settings/jira/test`, { method: "POST", headers, body: "{}" });
      expect(res2.status).toBe(429);
      expect(res2.headers.get("retry-after")).toBe("5");
      expect(calls).toBe(1);
    } finally { await app.stop(true); }
  });
});
