import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import type { AgentWriteOutcome } from "../../src/agents/agents-write.js";

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

type AgentsWriteOverrides = NonNullable<ViewDeps["agentsWrite"]>;
const unusedFn = (name: string) => (() => { throw new Error(`unused: ${name}`); }) as any;
/** `any`-typed deliberately: these stand in for every `agentsWrite` member regardless of its own arity, so a strict `(...a: unknown[]) => unknown` would fail contravariance against e.g. `(issue: string) => ...` call sites below. Returns the NON-optional member type (`NonNullable<...>`, never `... | undefined`) — assigning an explicitly-`| undefined`-typed value to `Partial<ViewDeps>`'s own optional `agentsWrite?:` property is itself refused under `exactOptionalPropertyTypes`. */
function agentsWriteDeps(overrides: Partial<Record<string, (...a: any[]) => any>> = {}): AgentsWriteOverrides {
  return {
    snapshot: unusedFn("snapshot"), start: unusedFn("start"), planStop: unusedFn("planStop"), stop: unusedFn("stop"),
    planShelve: unusedFn("planShelve"), shelve: unusedFn("shelve"), adopt: unusedFn("adopt"), prioritize: unusedFn("prioritize"),
    ...overrides,
  } as AgentsWriteOverrides;
}

const STARTED: AgentWriteOutcome = { ok: true, key: "FACTORY-1", startedUnderBoss: "FACTORY-BOSS" };

/**
 * FACTORY-666 review bar — the guard-chain battery every new write route
 * must pass: forged Origin, missing CSRF, wrong Content-Type, and a failing
 * peer-uid check are all refused BEFORE the route-specific write function
 * is ever called. Parameterized over every POST route this ticket adds so
 * each guard case is proven once per route without 4x duplicating the HTTP
 * plumbing per route (same guard-chain code every other write route in this
 * file already shares) — the write-shaped FUNCTION under test still runs
 * for real, through the real app, same as `rules-write-route.test.ts`'s own
 * per-route describe blocks.
 */
function guardBattery(path: string, agentsWriteOverrides: () => Partial<Record<string, (...a: unknown[]) => unknown>>, body: Record<string, unknown> = {}) {
  test(`${path}: forged Origin: 403, write never called`, async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps(wrapAll(agentsWriteOverrides(), () => { called = true; })) });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}${path}`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test(`${path}: missing CSRF header: 403, write never called`, async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps(wrapAll(agentsWriteOverrides(), () => { called = true; })) });
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST", headers: { origin, host, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test(`${path}: wrong Content-Type (text/plain): 415, write never called`, async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps(wrapAll(agentsWriteOverrides(), () => { called = true; })) });
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST", headers: { origin, host, "content-type": "text/plain", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(415);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test(`${path}: peer-uid check fails: 403, write never called`, async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf, false), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => false, agentsWrite: agentsWriteDeps(wrapAll(agentsWriteOverrides(), () => { called = true; })) });
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
}

/** Wraps every function in `fns` so calling ANY of them also flips the shared `called` flag — lets the guard battery above assert "nothing in agentsWrite was reached" without caring which specific member the route would have called. */
function wrapAll(fns: Partial<Record<string, (...a: unknown[]) => unknown>>, onCall: () => void): Partial<Record<string, (...a: unknown[]) => unknown>> {
  const wrapped: Partial<Record<string, (...a: unknown[]) => unknown>> = {};
  for (const [k, fn] of Object.entries(fns)) wrapped[k] = (...a: unknown[]) => { onCall(); return fn!(...a); };
  return wrapped;
}

describe("GET /api/agents/:issue", () => {
  test("not configured: 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1`, { headers: { origin, host } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("forged Origin: 403, snapshot never called", async () => {
    let called = false;
    const { app, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps({ snapshot: async () => { called = true; return { ok: true }; } }) });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/agents/FACTORY-1`, { headers: { origin: "http://evil.example", host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peer-uid check fails: 403, snapshot never called", async () => {
    let called = false;
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => false, agentsWrite: agentsWriteDeps({ snapshot: async () => { called = true; return { ok: true }; } }) });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1`, { headers: { origin, host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("all guards pass: returns the snapshot, no-store", async () => {
    const snapshot: AgentWriteOutcome = { ok: true, key: "FACTORY-1", status: "In Progress", summary: "x", labels: [], boss: "FACTORY-BOSS", running: true, pane: "pane-1" };
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps({ snapshot: async () => snapshot }) });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1`, { headers: { origin, host } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const { ok, ...rest } = snapshot as any;
      expect(await res.json()).toEqual(rest);
    } finally { await app.stop(true); }
  });

  test("a refusal from the snapshot reaches the UI verbatim", async () => {
    const { app, origin, host } = startApp({ dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, agentsWrite: agentsWriteDeps({ snapshot: async () => ({ ok: false, status: 404, error: "could not read FACTORY-1: boom" }) }) });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1`, { headers: { origin, host } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "could not read FACTORY-1: boom" });
    } finally { await app.stop(true); }
  });
});

describe("POST /api/agents/:issue/start", () => {
  guardBattery("/api/agents/FACTORY-1/start", () => ({ start: async () => STARTED }));

  test("all guards pass: calls agentsWrite.start and audits the accepted outcome", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let receivedIssue: string | undefined;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ start: async (issue: string) => { receivedIssue = issue; return STARTED; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/start`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(STARTED);
      expect(receivedIssue).toBe("FACTORY-1");
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("a refusal (e.g. no boss) passes through verbatim and audits rejected", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const refusal: AgentWriteOutcome = { ok: false, status: 409, error: "FACTORY-1 has no boss — adopt it first with a boss key" };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ start: async () => refusal }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/start`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: refusal.error });
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string; reason?: string }).outcome).toBe("rejected");
      expect((audited[0] as { outcome: string; reason?: string }).reason).toBe(refusal.error);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/agents/:issue/stop (AC2 — destructive, confirm-gated SERVER-side)", () => {
  guardBattery("/api/agents/FACTORY-1/stop", () => ({ planStop: async () => ({ ok: true, requiresConfirm: true, confirmReason: "agent-stop", preview: {} }), stop: async () => ({ ok: true }) }));

  test("omitting confirm ENTIRELY calls planStop, never stop — the plan is returned verbatim, UNAUDITED", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let stopCalled = false;
    const plan: AgentWriteOutcome = { ok: true, requiresConfirm: true, confirmReason: "agent-stop", preview: { key: "FACTORY-1", pane: "pane-1" } };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ planStop: async () => plan, stop: async () => { stopCalled = true; return { ok: true }; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      // No body at all — proves confirm is refused server-side even when the field is entirely absent, not merely falsy.
      const res = await fetch(`${origin}/api/agents/FACTORY-1/stop`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(plan);
      expect(stopCalled).toBe(false);
      expect(audited).toHaveLength(0);
    } finally { await app.stop(true); }
  });

  test("confirm:false explicitly also calls planStop, never stop", async () => {
    const csrf = createCsrfTokenIssuer();
    let stopCalled = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ planStop: async () => ({ ok: true, requiresConfirm: true, confirmReason: "agent-stop", preview: {} }), stop: async () => { stopCalled = true; return { ok: true }; } }),
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/stop`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ confirm: false }) });
      expect(res.status).toBe(200);
      expect(stopCalled).toBe(false);
    } finally { await app.stop(true); }
  });

  test("a plan-stage refusal (nothing running) IS audited as rejected", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const refusal: AgentWriteOutcome = { ok: false, status: 409, error: "no running agent for FACTORY-1 to stop" };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ planStop: async () => refusal }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/stop`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: refusal.error });
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });

  test("confirm:true calls stop (never planStop's own write path twice) and audits the accepted outcome", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let stopCalled = false;
    const outcome: AgentWriteOutcome = { ok: true, key: "FACTORY-1", stoppedPane: "pane-1" };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ stop: async () => { stopCalled = true; return outcome; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/stop`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ confirm: true }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(outcome);
      expect(stopCalled).toBe(true);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });
});

describe("POST /api/agents/:issue/shelve (AC2 — destructive, confirm-gated SERVER-side, plus a required reason)", () => {
  guardBattery("/api/agents/FACTORY-1/shelve", () => ({ planShelve: async () => ({ ok: true, requiresConfirm: true, confirmReason: "agent-shelve", preview: {} }), shelve: async () => ({ ok: true }) }), { reason: "because" });

  test("missing reason: 400, never reaches planShelve or shelve", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ planShelve: async () => { called = true; return { ok: true }; }, shelve: async () => { called = true; return { ok: true }; } }),
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/shelve`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("omitting confirm ENTIRELY (with a reason present) calls planShelve, never shelve — unaudited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let shelveCalled = false;
    const plan: AgentWriteOutcome = { ok: true, requiresConfirm: true, confirmReason: "agent-shelve", preview: { key: "FACTORY-1", boss: "FACTORY-BOSS", reason: "because" } };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ planShelve: async () => plan, shelve: async () => { shelveCalled = true; return { ok: true }; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/shelve`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ reason: "because" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(plan);
      expect(shelveCalled).toBe(false);
      expect(audited).toHaveLength(0);
    } finally { await app.stop(true); }
  });

  test("confirm:true calls shelve with the reason and audits accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let received: unknown[] = [];
    const outcome: AgentWriteOutcome = { ok: true, key: "FACTORY-1", shelvedUnderBoss: "FACTORY-BOSS", reason: "because" };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ shelve: async (...a: unknown[]) => { received = a; return outcome; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/shelve`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ reason: "because", confirm: true }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(outcome);
      expect(received).toEqual(["FACTORY-1", "because"]);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });
});

describe("POST /api/agents/:issue/adopt", () => {
  guardBattery("/api/agents/FACTORY-1/adopt", () => ({ adopt: async () => ({ ok: true, key: "FACTORY-1" }) }), { bossKey: "FACTORY-BOSS", disposition: "start" });

  test("missing bossKey: 400, adopt never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ adopt: async () => { called = true; return { ok: true }; } }),
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/adopt`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ disposition: "start" }) });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("invalid disposition: 400, adopt never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ adopt: async () => { called = true; return { ok: true }; } }),
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/adopt`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ bossKey: "FACTORY-BOSS", disposition: "nope" }) });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("all guards pass: calls adopt with the parsed input and audits accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let received: unknown[] = [];
    const outcome: AgentWriteOutcome = { ok: true, key: "FACTORY-1", alreadyAdopted: false };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ adopt: async (...a: unknown[]) => { received = a; return outcome; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/adopt`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "r" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(outcome);
      expect(received).toEqual(["FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "r" }]);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });
});

describe("POST /api/agents/:issue/prioritize", () => {
  guardBattery("/api/agents/FACTORY-1/prioritize", () => ({ prioritize: async () => ({ ok: true, key: "FACTORY-1", priority: "High" }) }), { priority: "High" });

  test("missing priority: 400, prioritize never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ prioritize: async () => { called = true; return { ok: true }; } }),
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/prioritize`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("all guards pass: calls prioritize and audits accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let received: unknown[] = [];
    const outcome: AgentWriteOutcome = { ok: true, key: "FACTORY-1", priority: "High" };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      agentsWrite: agentsWriteDeps({ prioritize: async (...a: unknown[]) => { received = a; return outcome; } }),
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/prioritize`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: JSON.stringify({ priority: "High" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(outcome);
      expect(received).toEqual(["FACTORY-1", "High"]);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });
});

describe("B1 — path-shape bypass is closed for every new agents-control write route", () => {
  // Same proof `rules-write-route.test.ts`'s own "B1" describe block makes
  // for the rules routes: the per-route `checkWriteGuard` call is NOT
  // merely redundant with `onRequest`'s own `/api/` prefix check — a
  // request to a route this ticket adds, with every guard header valid,
  // still only succeeds when `deps.writeGuard`/`deps.agentsWrite` are wired
  // up; an absent dep 503s rather than silently passing through.
  test("POST /api/agents/:issue/start with a valid guard but no agentsWrite dep: 503, never a silent pass", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/agents/FACTORY-1/start`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: "{}" });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });
});
