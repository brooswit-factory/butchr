import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import type { SettingsApiResponse } from "../../src/web/settings-api.js";
import { SettingsWriteRefusedError } from "../../src/settings/write-settings.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

function startApp(deps: Partial<ViewDeps>) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = app.server!.port!;
  if (deps.dashboardOriginGuard) deps.dashboardOriginGuard.port = port;
  if (deps.writeGuard) deps.writeGuard.dashboardOriginGuard.port = port;
  return { app, port, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

function writeGuardDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, peerOk = true) {
  return { dashboardOriginGuard: { port: 0 }, peerUidCheck: () => peerOk, csrf };
}

const EMPTY_RESPONSE: SettingsApiResponse = {
  settings: [],
  atlassianTokenFile: { key: "ATLASSIAN_TOKEN_FILE", path: null, source: "default", restartNeeded: true, secret: false, description: "d", exists: false, readable: false, mode: null, tooOpen: null },
};

describe("PUT /api/settings/:key", () => {
  test("not configured (no settingsWrite dep): 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ value: "12" }),
      });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("forged Origin: 403, settingsWrite never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async () => { called = true; return EMPTY_RESPONSE; },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ value: "12" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("missing value field: 400, settingsWrite never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async () => { called = true; return EMPTY_RESPONSE; },
    });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("valid write: 200, body is the fresh settings response, audited", async () => {
    const csrf = createCsrfTokenIssuer();
    let receivedArgs: unknown[] = [];
    const audited: unknown[] = [];
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async (key, value, confirm) => { receivedArgs = [key, value, confirm]; return EMPTY_RESPONSE; },
      auditWrite: (e) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ value: "12" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EMPTY_RESPONSE);
      expect(receivedArgs).toEqual(["BUTCHR_MAX_AGENTS", "12", false]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(audited).toHaveLength(1);
    } finally { await app.stop(true); }
  });

  test("confirm:true is passed through", async () => {
    const csrf = createCsrfTokenIssuer();
    let receivedConfirm: unknown;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async (_k, _v, confirm) => { receivedConfirm = confirm; return EMPTY_RESPONSE; },
    });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ value: "60", confirm: true }),
      });
      expect(res.status).toBe(200);
      expect(receivedConfirm).toBe(true);
    } finally { await app.stop(true); }
  });

  test("a SettingsWriteRefusedError thrown by settingsWrite: 400 with its message, audited as rejected", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async () => { throw new SettingsWriteRefusedError("BUTCHR_MAX_AGENTS=60 is above the confirm ceiling (50) — retry with confirm: true to proceed", true); },
      auditWrite: (e) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ value: "60" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/confirm ceiling/);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });

  test("no CSRF token: 403, settingsWrite never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      settingsWrite: async () => { called = true; return EMPTY_RESPONSE; },
    });
    try {
      const res = await fetch(`${origin}/api/settings/BUTCHR_MAX_AGENTS`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json" },
        body: JSON.stringify({ value: "12" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/daemon/restart", () => {
  test("not configured (no daemonRestart dep): 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/daemon/restart`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("missing confirm:true: 400, daemonRestart never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonRestart: async () => { called = true; return { ok: true }; },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/restart`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("confirm:true, systemd not detected: 409 from daemonRestart, passed through", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonRestart: async () => ({ ok: false, status: 409, error: "restart butchr manually" }),
    });
    try {
      const res = await fetch(`${origin}/api/daemon/restart`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "restart butchr manually" });
    } finally { await app.stop(true); }
  });

  test("confirm:true, systemd detected: 200, audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonRestart: async () => { called = true; return { ok: true }; },
      auditWrite: (e) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/restart`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(200);
      expect(called).toBe(true);
      expect(audited).toHaveLength(1);
    } finally { await app.stop(true); }
  });

  test("rate limited: 429 with Retry-After, daemonRestart never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonRestart: async () => { called = true; return { ok: true }; },
      daemonRestartRateLimit: () => ({ ok: false, retryAfterSeconds: 537 }),
    });
    try {
      const res = await fetch(`${origin}/api/daemon/restart`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("537");
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("forged Origin: 403, daemonRestart never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonRestart: async () => { called = true; return { ok: true }; },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/daemon/restart`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});
