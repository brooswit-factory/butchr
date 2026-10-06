import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import type { SetupStatusResponse, JiraWriteRequestOutcome } from "../../src/web/setup-api.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

function writeDeps(overrides: Partial<ViewDeps> = {}) {
  const csrf = createCsrfTokenIssuer();
  const guard = { port: 0 };
  const peerUidCheck = () => true;
  return { csrf, writeGuard: { dashboardOriginGuard: guard, peerUidCheck, csrf }, dashboardOriginGuard: guard, peerUidCheck, ...overrides };
}

async function csrfToken(port: number): Promise<string> {
  const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
  return ((await session.json()) as { csrfToken: string }).csrfToken;
}

const OK_RESULT: JiraWriteRequestOutcome = { ok: true, status: 200, body: { ok: true, accountId: "acct-1", displayName: "D", rotated: false, restartNeeded: true } };

describe("GET /api/setup/status", () => {
  test("no dashboardOriginGuard: 503, never calls setupStatus()", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ setupStatus: () => { called = true; return { configured: false }; } }));
    const res = await app.handle(new Request("http://local/api/setup/status", { headers: { origin: "http://x", host: "x" } }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("peerUidCheck rejects: 403, never calls setupStatus()", async () => {
    let called = false;
    const guard = { port: 0 };
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: guard, peerUidCheck: () => false, setupStatus: () => { called = true; return { configured: false }; } }));
    app.listen(0);
    const port = app.server!.port!;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("all guards pass: 200, Cache-Control: no-store, exact body", async () => {
    const guard = { port: 0 };
    const body: SetupStatusResponse = { configured: false };
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: guard, peerUidCheck: () => true, setupStatus: () => body }));
    app.listen(0);
    const port = app.server!.port!;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(body);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/setup/jira", () => {
  test("no writeGuard: 503, never calls setupJiraWrite()", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ setupJiraWrite: async () => { called = true; return OK_RESULT; } }));
    const res = await app.handle(new Request("http://local/api/setup/jira", { method: "POST", headers: { origin: "http://x", host: "x", "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("missing CSRF: 403, never calls setupJiraWrite()", async () => {
    let called = false;
    const deps = writeDeps({ setupJiraWrite: async () => { called = true; return OK_RESULT; } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("valid CSRF, no setupJiraWrite dep: 503", async () => {
    const deps = writeDeps();
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token }, body: "{}" });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("malformed body (missing fields): 400, never calls setupJiraWrite()", async () => {
    let called = false;
    const deps = writeDeps({ setupJiraWrite: async () => { called = true; return OK_RESULT; } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers, body: JSON.stringify({ site: "https://x.atlassian.net" }) });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("happy path: calls setupJiraWrite with the exact body fields, returns its status/body verbatim, audits accepted with no secret fields in ids/diffSummary", async () => {
    let received: unknown;
    const audited: Array<{ outcome: string; ids: string[]; diffSummary: string }> = [];
    const deps = writeDeps({
      setupJiraWrite: async (input) => { received = input; return OK_RESULT; },
      auditWrite: (e) => { audited.push(e); },
    });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const payload = { site: "https://x.atlassian.net", email: "a@b.c", token: "canary-token-value", setupCode: "ABCDEFGHJKMN" };
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers, body: JSON.stringify(payload) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(OK_RESULT.body);
      expect(received).toEqual(payload);
      expect(audited).toHaveLength(1);
      expect(audited[0]!.outcome).toBe("accepted");
      expect(JSON.stringify(audited[0]!.ids)).not.toContain("canary-token-value");
      expect(audited[0]!.diffSummary).not.toContain("canary-token-value");
      expect(audited[0]!.diffSummary).not.toContain("ABCDEFGHJKMN");
    } finally { await app.stop(true); }
  });

  test("a refusal from setupJiraWrite is returned verbatim (status + body) and audited as rejected", async () => {
    const audited: Array<{ outcome: string }> = [];
    const refusal: JiraWriteRequestOutcome = { ok: false, status: 400, body: { error: "setup code: mismatch" } };
    const deps = writeDeps({ setupJiraWrite: async () => refusal, auditWrite: (e) => { audited.push(e); } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers, body: JSON.stringify({ site: "s", email: "e", token: "t", setupCode: "c" }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(refusal.body);
      expect(audited[0]!.outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });

  test("the test-rate-limiter refuses before the write-rate-limiter and before setupJiraWrite is ever called", async () => {
    let called = false;
    const deps = writeDeps({
      setupJiraWrite: async () => { called = true; return OK_RESULT; },
      jiraTokenTestRateLimit: () => ({ ok: false, retryAfterSeconds: 42 }),
    });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers, body: JSON.stringify({ site: "s", email: "e", token: "t", setupCode: "c" }) });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("the write-rate-limiter (3/hour) refuses even when the test-rate-limiter allows", async () => {
    let called = false;
    const deps = writeDeps({
      setupJiraWrite: async () => { called = true; return OK_RESULT; },
      jiraTokenTestRateLimit: () => ({ ok: true }),
      jiraTokenWriteRateLimit: () => ({ ok: false, retryAfterSeconds: 3600 }),
    });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, { method: "POST", headers, body: JSON.stringify({ site: "s", email: "e", token: "t", setupCode: "c" }) });
      expect(res.status).toBe(429);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});

describe("PUT /api/settings/jira/token", () => {
  test("no writeGuard: 503, never calls jiraTokenRotate()", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ jiraTokenRotate: async () => { called = true; return OK_RESULT; } }));
    const res = await app.handle(new Request("http://local/api/settings/jira/token", { method: "PUT", headers: { origin: "http://x", host: "x", "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("malformed body: 400, never calls jiraTokenRotate()", async () => {
    let called = false;
    const deps = writeDeps({ jiraTokenRotate: async () => { called = true; return OK_RESULT; } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/token`, { method: "PUT", headers, body: JSON.stringify({ setupCode: "c" }) });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("happy path: calls jiraTokenRotate with exactly {token, setupCode} (never site/email from the body), returns its result, audits accepted", async () => {
    let received: unknown;
    const audited: Array<{ outcome: string }> = [];
    const deps = writeDeps({ jiraTokenRotate: async (input) => { received = input; return OK_RESULT; }, auditWrite: (e) => { audited.push(e); } });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const payload = { token: "canary-new-token", setupCode: "ABCDEFGHJKMN", site: "https://should-be-ignored.atlassian.net", email: "ignored@b.c" };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/token`, { method: "PUT", headers, body: JSON.stringify(payload) });
      expect(res.status).toBe(200);
      expect(received).toEqual({ token: "canary-new-token", setupCode: "ABCDEFGHJKMN" });
      expect(audited[0]!.outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("a 409 env-provided refusal is returned verbatim", async () => {
    const refusal: JiraWriteRequestOutcome = { ok: false, status: 409, body: { error: "provided by environment" } };
    const deps = writeDeps({ jiraTokenRotate: async () => refusal });
    const app = liveView(fakeMcp, baseDeps(deps));
    app.listen(0);
    const port = app.server!.port!;
    deps.dashboardOriginGuard.port = port;
    try {
      const token = await csrfToken(port);
      const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, "content-type": "application/json", "x-butchr-csrf": token };
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/jira/token`, { method: "PUT", headers, body: JSON.stringify({ token: "t", setupCode: "c" }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "provided by environment" });
    } finally { await app.stop(true); }
  });
});
