import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER, BODY_CAP_BYTES } from "../../src/web/write-guard.js";
import type { RulesWriteOutcome, RulesPlanOutcome } from "../../src/rules/rules-write.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

/**
 * Starts a REAL listening app (same reason `rules-api-route.test.ts` does:
 * `server.requestIP` needs a real Bun server) and returns ready-made
 * allowed headers. `deps.dashboardOriginGuard` is a MUTABLE object
 * (`checkDashboardOrigin` reads it fresh per-request, same precedent as
 * `rules-api-route.test.ts`'s own `startApp`) — this helper listens on an
 * OS-assigned port FIRST and only then writes that port into the guard, so
 * every allowed-origin test actually matches the real listening port.
 */
function startApp(deps: Partial<ViewDeps>) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = app.server!.port!;
  if (deps.dashboardOriginGuard) deps.dashboardOriginGuard.port = port;
  if (deps.writeGuard) deps.writeGuard.dashboardOriginGuard.port = port; // a SEPARATE object from the one above in most call sites here — see `writeGuardDeps`'s own literal
  return { app, port, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

const ACCEPTED: RulesWriteOutcome = { ok: true, backupId: "20261005T180000Z", etag: "etag-next", changedIds: ["ui-first-rule"], reload: { applied: true, problems: [] } };

function writeGuardDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, peerOk = true) {
  return { dashboardOriginGuard: { port: 0 }, peerUidCheck: () => peerOk, csrf };
}

describe("GET /api/session", () => {
  test("not configured: 503", async () => {
    const { app, origin, host } = startApp({});
    try {
      const res = await fetch(`${origin}/api/session`, { headers: { origin, host } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("forged origin: 403, never reaches the csrf issuer", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/session`, { headers: { origin: "http://evil.example", host } });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("missing Origin: 403", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/session`, { headers: { host } });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("wrong Host (right Origin, mismatched Host header): 403", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/session`, { headers: { origin, host: "localhost:1" } });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("peer-uid check fails (other-uid peer): 403", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf, false), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => false });
    try {
      const res = await fetch(`${origin}/api/session`, { headers: { origin, host } });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });

  test("all guards pass: 200, hands out the live token, no-store", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`${origin}/api/session`, { headers: { origin, host } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json() as { csrfToken: string };
      expect(body.csrfToken).toBe(csrf.token);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/rules/:id/enabled — write guard go-red cases", () => {
  function buildDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, onEnabled: (...a: unknown[]) => Promise<RulesWriteOutcome>, audited: unknown[]) {
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      rulesWrite: { enabled: onEnabled as any, fields: (() => { throw new Error("unused"); }) as any, undo: (() => { throw new Error("unused"); }) as any, plan: (() => { throw new Error("unused"); }) as any },
      auditWrite: (e: unknown) => { audited.push(e); },
    };
  }

  test("forged Origin: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const audited: unknown[] = [];
    const { app, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
      expect(audited.length).toBe(0);
    } finally { await app.stop(true); }
  });

  test("no Origin but Sec-Fetch-Site: same-origin: still 403, write never called — this guard has no GET-only fallback to leak into a write (manager-factory review, 2026-10-05)", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { host, "sec-fetch-site": "same-origin", "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("missing CSRF header: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong CSRF header: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: "0".repeat(csrf.token.length) },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong Content-Type (text/plain): 415, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "text/plain", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(415);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("oversized body (above the 64KB cap), from an ALLOWED origin with a valid token: 413, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const big = "x".repeat(BODY_CAP_BYTES + 1024);
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", padding: big }),
      });
      expect(res.status).toBe(413);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("a 10MB body from a FORBIDDEN origin is refused by the Origin guard alone — never read", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const huge = "x".repeat(10 * 1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", padding: huge }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("invalid JSON body: 400, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("all guards pass: the route calls rulesWrite.enabled and returns + audits its outcome (accepted)", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let receivedArgs: unknown[] = [];
    const { app, origin, host } = startApp(buildDeps(csrf, async (...a) => { receivedArgs = a; return ACCEPTED; }, audited));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "etag-1", confirm: true, planHash: "hash-1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ACCEPTED);
      expect(receivedArgs).toEqual(["ui-first-rule", true, "etag-1", true, "hash-1"]);
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("rulesWrite.enabled refuses (e.g. non-ui- id): status/error pass through, and the REJECTED outcome is audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const refusal: RulesWriteOutcome = { ok: false, status: 403, error: `rule "managers" does not carry the "ui-" prefix` };
    const { app, origin, host } = startApp(buildDeps(csrf, async () => refusal, audited));
    try {
      const res = await fetch(`${origin}/api/rules/managers/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: refusal.error });
      expect(audited).toHaveLength(1);
      expect((audited[0] as { outcome: string; reason?: string }).outcome).toBe("rejected");
      expect((audited[0] as { outcome: string; reason?: string }).reason).toBe(refusal.error);
    } finally { await app.stop(true); }
  });

  test("body missing required fields: 400, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { called = true; return ACCEPTED; }, []));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});

describe("PUT /api/rules/:id", () => {
  function buildDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, onFields: (...a: unknown[]) => RulesWriteOutcome) {
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      rulesWrite: { enabled: (() => { throw new Error("unused"); }) as any, fields: onFields as any, undo: (() => { throw new Error("unused"); }) as any, plan: (() => { throw new Error("unused"); }) as any },
    };
  }

  test("disallowed field (e.g. harness, or an unknown key): 400, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, () => { called = true; return ACCEPTED; }));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ ifMatch: "x", planHash: "h", harness: "claude" }),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("attempting to change `enabled` via PUT: 400, write never called — the dedicated enable route owns that field", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host } = startApp(buildDeps(csrf, () => { called = true; return ACCEPTED; }));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ ifMatch: "x", planHash: "h", enabled: true }),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("valid query edit: 200, write called with the parsed patch", async () => {
    const csrf = createCsrfTokenIssuer();
    let receivedArgs: unknown[] = [];
    const { app, origin, host } = startApp(buildDeps(csrf, (...a) => { receivedArgs = a; return ACCEPTED; }));
    try {
      const res = await fetch(`${origin}/api/rules/ui-first-rule`, {
        method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ ifMatch: "etag-1", planHash: "hash-1", query: "project = X" }),
      });
      expect(res.status).toBe(200);
      expect(receivedArgs).toEqual(["ui-first-rule", { query: "project = X" }, "etag-1", false, "hash-1"]);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/undo/:backupId", () => {
  test("valid request calls rulesWrite.undo and audits the outcome", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let receivedId: string | undefined;
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      rulesWrite: {
        enabled: (() => { throw new Error("unused"); }) as any,
        fields: (() => { throw new Error("unused"); }) as any,
        undo: ((backupId: string) => { receivedId = backupId; return ACCEPTED; }) as any,
        plan: (() => { throw new Error("unused"); }) as any,
      },
      auditWrite: (e: unknown) => { audited.push(e); },
    });
    try {
      const res = await fetch(`${origin}/api/undo/20261005T180000Z`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(receivedId).toBe("20261005T180000Z");
      expect(audited).toHaveLength(1);
    } finally { await app.stop(true); }
  });

  test("forged Origin: 403, undo never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      rulesWrite: { enabled: (() => { throw new Error("unused"); }) as any, fields: (() => { throw new Error("unused"); }) as any, undo: (() => { called = true; return ACCEPTED; }) as any, plan: (() => { throw new Error("unused"); }) as any },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/undo/20261005T180000Z`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/rules/plan — report-only", () => {
  test("never calls a write dep, returns the plan outcome", async () => {
    const csrf = createCsrfTokenIssuer();
    const planResult: RulesPlanOutcome = { ok: true, planHash: "h1", spawned: 1, stopped: 0, restarted: 0, scope: 3, etag: "etag-1", requiresConfirm: false };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
      rulesWrite: {
        enabled: (() => { throw new Error("unused"); }) as any,
        fields: (() => { throw new Error("unused"); }) as any,
        undo: (() => { throw new Error("unused"); }) as any,
        plan: (async () => planResult) as any,
      },
    });
    try {
      const res = await fetch(`${origin}/api/rules/plan`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ id: "ui-first-rule", patch: { enabled: true } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(planResult);
    } finally { await app.stop(true); }
  });
});

// AGENTSAFETY FIRST-PASS FINDING B1 (SHIP-BLOCKER, 2026-10-06): a trailing
// slash (or other path variant) on a write route previously bypassed the
// guard entirely and returned 200 with NO Origin, CSRF, or peer check —
// `onRequest`'s own exact-regex path match never fired, but Elysia's
// router still dispatched the request to the real handler. These tests
// send every variant WITHOUT any credentials at all; each must come back
// refused (403/404/415/400 — never 200, and the underlying write dep must
// never be called), proving both of the fix's layers hold: the broad
// `startsWith("/api/")` net in `onRequest`, AND each route handler's own
// `checkWriteGuard` call.
describe("B1 — path-shape bypass is closed for every write route", () => {
  const PATH_VARIANTS = (base: string) => [
    `${base}/`, // trailing slash
    base.replace(/\//g, "//"), // repeated slash
    `${base}/.`, // dot segment
    `${base}%2f`, // encoded slash appended
  ];

  function buildRefusingDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, called: { enabled: boolean; fields: boolean; undo: boolean }) {
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      rulesWrite: {
        enabled: (async () => { called.enabled = true; return ACCEPTED; }) as any,
        fields: (() => { called.fields = true; return ACCEPTED; }) as any,
        undo: (() => { called.undo = true; return ACCEPTED; }) as any,
        plan: (async () => ({ ok: true, planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: null, etag: "e", requiresConfirm: false })) as any,
      },
    };
  }

  test("POST /api/rules/:id/enabled path variants, with NO Origin/CSRF at all: never 200, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    const called = { enabled: false, fields: false, undo: false };
    const { app, port } = startApp(buildRefusingDeps(csrf, called));
    try {
      for (const path of PATH_VARIANTS("/api/rules/ui-first-rule/enabled")) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
        });
        expect(res.status).not.toBe(200);
      }
      expect(called.enabled).toBe(false);
    } finally { await app.stop(true); }
  });

  test("PUT /api/rules/:id path variants, with NO Origin/CSRF at all: never 200, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    const called = { enabled: false, fields: false, undo: false };
    const { app, port } = startApp(buildRefusingDeps(csrf, called));
    try {
      for (const path of PATH_VARIANTS("/api/rules/ui-first-rule")) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ifMatch: "x", planHash: "h", query: "x" }),
        });
        expect(res.status).not.toBe(200);
      }
      expect(called.fields).toBe(false);
    } finally { await app.stop(true); }
  });

  test("POST /api/undo/:backupId path variants, with NO Origin/CSRF at all: never 200, undo never called", async () => {
    const csrf = createCsrfTokenIssuer();
    const called = { enabled: false, fields: false, undo: false };
    const { app, port } = startApp(buildRefusingDeps(csrf, called));
    try {
      for (const path of PATH_VARIANTS("/api/undo/20261005T000000Z")) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(res.status).not.toBe(200);
      }
      expect(called.undo).toBe(false);
    } finally { await app.stop(true); }
  });

  test("POST /api/rules/plan path variants, with NO Origin/CSRF at all: never 200", async () => {
    const csrf = createCsrfTokenIssuer();
    const called = { enabled: false, fields: false, undo: false };
    const { app, port } = startApp(buildRefusingDeps(csrf, called));
    try {
      for (const path of PATH_VARIANTS("/api/rules/plan")) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ui-first-rule", patch: {} }) });
        expect(res.status).not.toBe(200);
      }
    } finally { await app.stop(true); }
  });

  test("a totally unmapped non-GET path under /api/ is still refused (403), not a bare 404 that would reveal route existence", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, port } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
    } finally { await app.stop(true); }
  });
});
