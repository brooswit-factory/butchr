import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import type { DaemonLogsResult } from "../../src/web/daemon-logs.js";
import type { ReloadResult } from "../../src/rules/reload.js";

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

const OK_LOGS: DaemonLogsResult = { ok: true, source: "journalctl --user -u butchr.service", unit: "butchr.service", lines: ["hello"], truncated: false };
const SEEDED_SECRET_LOGS: DaemonLogsResult = { ok: true, source: "journalctl --user -u butchr.service", unit: "butchr.service", lines: ["fetched with Authorization: Bearer [redacted]"], truncated: false };

describe("GET /api/daemon/logs", () => {
  test("not configured (no dashboardOriginGuard): 503", async () => {
    const { app, origin, host } = startApp({ daemonLogs: async () => OK_LOGS, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/daemon/logs`, { headers: { origin, host } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("no Origin: 403, daemonLogs never called (no GET-only fallback for this route)", async () => {
    let called = false;
    const { app, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, daemonLogs: async () => { called = true; return OK_LOGS; } });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/daemon/logs`, { headers: { host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong Origin: 403, daemonLogs never called", async () => {
    let called = false;
    const { app, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, daemonLogs: async () => { called = true; return OK_LOGS; } });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/daemon/logs`, { headers: { origin: "http://evil.example", host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peer-uid check fails: 403, daemonLogs never called", async () => {
    let called = false;
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => false, daemonLogs: async () => { called = true; return OK_LOGS; } });
    try {
      const res = await fetch(`${origin}/api/daemon/logs`, { headers: { origin, host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("daemonLogs not configured: 503", async () => {
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/daemon/logs`, { headers: { origin, host } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("source unavailable (ok:false from the dep): 503 with the operator-actionable message", async () => {
    const { app, origin, host } = startApp({
      dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonLogs: async () => ({ ok: false, error: "no systemd unit or scheduled task detected for this daemon — logs are unavailable; check the process running this daemon directly" }),
    });
    try {
      const res = await fetch(`${origin}/api/daemon/logs`, { headers: { origin, host } });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/no systemd unit or scheduled task detected/);
    } finally { await app.stop(true); }
  });

  test("valid read: 200, no-store, body is the daemonLogs result verbatim — never an unredacted secret", async () => {
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, daemonLogs: async () => SEEDED_SECRET_LOGS });
    try {
      const res = await fetch(`${origin}/api/daemon/logs`, { headers: { origin, host } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toEqual(SEEDED_SECRET_LOGS);
      expect(JSON.stringify(body)).not.toContain("Bearer sk-");
    } finally { await app.stop(true); }
  });
});

const RELOAD_OK: ReloadResult = { ok: true, path: "/x/rules.json", added: [], removed: [], changed: [], problems: [], sourceEtag: "etag-1" } as ReloadResult;
const RELOAD_FAILED: ReloadResult = { ok: false, path: "/x/rules.json", added: [], removed: [], changed: [], problems: ["bad json"], sourceEtag: undefined } as unknown as ReloadResult;

describe("POST /api/daemon/reload", () => {
  test("not configured (no writeGuard dep): 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, daemonReload: () => RELOAD_OK });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("forged Origin: 403, daemonReload never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => { called = true; return RELOAD_OK; },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/daemon/reload`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}",
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peer-uid check fails: 403, daemonReload never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf, false), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => false,
      daemonReload: () => { called = true; return RELOAD_OK; },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("no CSRF token: 403, daemonReload never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => { called = true; return RELOAD_OK; },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong Content-Type: 415, daemonReload never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => { called = true; return RELOAD_OK; },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "text/plain", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(415);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("daemonReload not configured: 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("rate limited: 429 with Retry-After, daemonReload never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => { called = true; return RELOAD_OK; },
      writeRateLimit: () => ({ ok: false, retryAfterSeconds: 42 }),
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("success: 200, result verbatim, audited as accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => { called = true; return RELOAD_OK; },
      auditWrite: (e) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(200);
      expect(called).toBe(true);
      expect(await res.json()).toEqual(RELOAD_OK);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("reload failure (bad rules.json): 409, audited as rejected, problems surfaced verbatim", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      daemonReload: () => RELOAD_FAILED,
      auditWrite: (e) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/daemon/reload`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/bad json/);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });
});
