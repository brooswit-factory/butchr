import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER, BODY_CAP_BYTES } from "../../src/web/write-guard.js";
import { writeRuleEnabled, planRuleWrite, type RulesWriteOutcome, type RulesPlanOutcome } from "../../src/rules/rules-write.js";
import { rulesEtag } from "../../src/rules/write-rules.js";
import type { RulesEnv } from "../../src/rules/rules.js";
import { createWriteRateLimiter } from "../../src/web/write-rate-limit.js";
import { createAuditLogger } from "../../src/web/audit-log.js";

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

  // S1 (agentsafety second pass, 2026-10-05): the dashboard's own
  // same-origin `fetch("/api/session")` carries NO `Origin` header at all
  // (the Fetch spec only stamps `Origin` on a non-GET/cross-origin
  // request) — the session route must accept the SAME no-Origin +
  // `Sec-Fetch-Site: same-origin` fallback the other GET routes already
  // do, or the dashboard can never even start a session.
  test("S1: no Origin but Sec-Fetch-Site: same-origin and a matching Host: 200, hands out the token", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/session`, { headers: { host, "sec-fetch-site": "same-origin" } });
      expect(res.status).toBe(200);
      const body = await res.json() as { csrfToken: string };
      expect(body.csrfToken).toBe(csrf.token);
    } finally { await app.stop(true); }
  });

  test("no Origin and NO Sec-Fetch-Site at all: still 403 (fail closed, not a blanket no-Origin pass)", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, host } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server as any).port}/api/session`, { headers: { host } });
      expect(res.status).toBe(403);
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

describe("N2 (FACTORY-678): server-side per-client write flood limit, 429 + Retry-After", () => {
  function buildDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, onEnabled: (...a: unknown[]) => Promise<RulesWriteOutcome>, writeRateLimit: NonNullable<ViewDeps["writeRateLimit"]>, audited: unknown[] = []) {
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      writeRateLimit,
      rulesWrite: {
        enabled: onEnabled as any,
        fields: (() => { throw new Error("unused"); }) as any,
        undo: (() => { throw new Error("unused"); }) as any,
        plan: (async () => ({ ok: true, planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: null, etag: "e", requiresConfirm: false })) as any,
      },
      auditWrite: (e: unknown) => { audited.push(e); },
    };
  }

  test("30 requests inside the budget window to the same client: the first N are processed, the rest 429 with Retry-After, write never called for those", async () => {
    const csrf = createCsrfTokenIssuer();
    let calls = 0;
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 5 }); // real Date.now, but the whole burst below runs well within 10s
    const { app, origin, host } = startApp(buildDeps(csrf, async () => { calls++; return ACCEPTED; }, writeRateLimit));
    try {
      const statuses: number[] = [];
      const retryAfters: (string | null)[] = [];
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
          method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
          body: JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" }),
        });
        statuses.push(res.status);
        retryAfters.push(res.headers.get("retry-after"));
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses.slice(5)).toEqual(new Array(25).fill(429));
      expect(calls).toBe(5); // the write dep was never reached for the refused 25
      // N2 contract (FACTORY-663/PR #650 pinned this at its head 46d1494):
      // `Retry-After` must be a bare non-negative INTEGER number of
      // seconds — PR #650 parses it with `Number.parseInt(header, 10)`
      // and silently drops the retry time (no error, no log) on anything
      // else, including an HTTP-date or a fractional value. Assert the
      // exact wire string, not just `Number(ra) > 0` — a value like
      // `"6.5"` or a date string would pass that weaker check while
      // breaking #650's parser.
      for (const ra of retryAfters.slice(5)) {
        expect(ra).not.toBeNull();
        expect(ra).toMatch(/^[0-9]+$/);
        expect(Number.parseInt(ra!, 10)).toBeGreaterThanOrEqual(0);
      }
    } finally { await app.stop(true); }
  });

  test("a 429'd write wrote NOTHING — the rules file is byte-identical, not merely a 429 status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rules-write-route-"));
    try {
      const envDeps: RulesEnv = { XDG_CONFIG_HOME: dir };
      mkdirSync(join(dir, "butchr"), { recursive: true });
      const rulesFilePath = join(dir, "butchr", "rules.json");
      const originalText = JSON.stringify({ rules: [{ id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "do the thing", enabled: false }] }, null, 2) + "\n";
      writeFileSync(rulesFilePath, originalText);
      const writeDeps = { env: envDeps };
      const scopeOf = async () => 0;
      const plan = await planRuleWrite("ui-first-rule", { enabled: true }, false, scopeOf, writeDeps);
      if (!plan.ok) throw new Error("expected a successful plan");
      const etag = rulesEtag(envDeps);

      const csrf = createCsrfTokenIssuer();
      const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
      const { app, origin, host } = startApp({
        csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, writeRateLimit,
        rulesWrite: {
          enabled: ((id: string, enabled: boolean, ifMatch: string, confirm: boolean, planHash: string) => writeRuleEnabled(id, enabled, ifMatch, confirm, planHash, scopeOf, writeDeps)) as any,
          fields: (() => { throw new Error("unused"); }) as any,
          undo: (() => { throw new Error("unused"); }) as any,
          plan: (() => { throw new Error("unused"); }) as any,
        },
      });
      try {
        const body = JSON.stringify({ enabled: true, ifMatch: etag, planHash: plan.planHash });
        const first = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body });
        expect(first.status).toBe(200); // consumes the budget (max: 1)
        const second = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body });
        expect(second.status).toBe(429);
        // The first write DID land (enabled: true); a SECOND identical
        // attempt is refused by the limiter before `rulesWrite.enabled`
        // ever runs again — the file must be exactly as the first write
        // left it, not reverted, not double-written.
        const afterFirstWrite = JSON.parse(readFileSync(rulesFilePath, "utf8"));
        expect(afterFirstWrite.rules[0].enabled).toBe(true);
      } finally { await app.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejected (429) attempts are audited through the SAME rejected-write pipeline as any other refusal", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host } = startApp(buildDeps(csrf, async () => ACCEPTED, writeRateLimit, audited));
    try {
      const body = JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" });
      await fetch(`${origin}/api/rules/ui-first-rule/enabled`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body });
      await fetch(`${origin}/api/rules/ui-first-rule/enabled`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body });
      expect(audited).toHaveLength(2);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
      expect((audited[1] as { outcome: string; reason?: string }).outcome).toBe("rejected");
      expect((audited[1] as { outcome: string; reason?: string }).reason).toMatch(/rate limited/);
    } finally { await app.stop(true); }
  });

  test("ALERT COUNT STAYS BOUNDED across a rejected-write burst (B4's existing aggregation covers N2's new 429s too)", async () => {
    let posted = 0;
    // A generous window (not the module's own 10s default, but not so
    // short a slow CI host's own scheduling jitter could make the burst
    // below spill past it before the aggregation timer fires) — the test
    // polls for the eventual count rather than sleeping a fixed amount,
    // so it is not itself a source of flakiness either way.
    const AGGREGATE_WINDOW_MS = 500;
    const auditWrite = createAuditLogger({
      append: () => {}, // skip the real file for this test
      postAlert: async () => { posted++; },
      host: "test-host",
      log: () => {},
      rejectAggregateWindowMs: AGGREGATE_WINDOW_MS,
    });
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, writeRateLimit, auditWrite,
      rulesWrite: {
        enabled: (async () => ACCEPTED) as any,
        fields: (() => { throw new Error("unused"); }) as any,
        undo: (() => { throw new Error("unused"); }) as any,
        plan: (() => { throw new Error("unused"); }) as any,
      },
    });
    try {
      const body = JSON.stringify({ enabled: true, ifMatch: "x", planHash: "h" });
      // One accepted (alerts immediately) + a burst of 10 rejected (429'd by the limiter) within the aggregation window.
      for (let i = 0; i < 11; i++) {
        await fetch(`${origin}/api/rules/ui-first-rule/enabled`, { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body });
      }
      expect(posted).toBe(1); // the single accepted write's own immediate alert; the 10 rejections haven't posted yet (still aggregating)
      // Poll for the aggregation timer to fire, rather than a fixed sleep —
      // bounded well under AGGREGATE_WINDOW_MS's own margin, so this is a
      // deadline, not a race.
      const deadline = Date.now() + AGGREGATE_WINDOW_MS * 4;
      while (posted < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(posted).toBe(2); // exactly one more: the aggregated rejection alert, not 10
    } finally { await app.stop(true); }
  });

  test("a plan-then-apply pair (N1's own happy path) is never itself rate-limited, even sharing ONE limiter instance across both routes", async () => {
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter(); // real default budget (10/min)
    const planResult: RulesPlanOutcome = { ok: true, planHash: "h1", spawned: 1, stopped: 0, restarted: 0, scope: 1, etag: "etag-1", requiresConfirm: false };
    const { app, origin, host } = startApp({
      csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true, writeRateLimit,
      rulesWrite: {
        enabled: (async () => ACCEPTED) as any,
        fields: (() => { throw new Error("unused"); }) as any,
        undo: (() => { throw new Error("unused"); }) as any,
        plan: (async () => planResult) as any,
      },
    });
    try {
      const planRes = await fetch(`${origin}/api/rules/plan`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ id: "ui-first-rule", patch: { enabled: true } }),
      });
      expect(planRes.status).toBe(200);
      const applyRes = await fetch(`${origin}/api/rules/ui-first-rule/enabled`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ enabled: true, ifMatch: "etag-1", planHash: planResult.planHash }),
      });
      expect(applyRes.status).toBe(200);
    } finally { await app.stop(true); }
  });
});

describe("N3 (FACTORY-678): stale-lock refusal reaches the HTTP response BODY, with the absolute path and the rm hint", () => {
  function realWriteDeps(dir: string) {
    const envDeps: RulesEnv = { XDG_CONFIG_HOME: dir };
    mkdirSync(join(dir, "butchr"), { recursive: true });
    const rulesFilePath = join(dir, "butchr", "rules.json");
    writeFileSync(rulesFilePath, JSON.stringify({ rules: [{ id: "ui-first-rule", resourceProvider: "jira-work", query: "project = BUTCHR", brief: "x", enabled: false }] }, null, 2) + "\n");
    return { envDeps, rulesFilePath, lockPath: join(dir, "butchr", ".rules.lock") };
  }

  test("a dead-pid stale lock: the HTTP response body's error contains the absolute lock path and the rm hint, status 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-stale-lock-route-"));
    try {
      const { envDeps, lockPath } = realWriteDeps(dir);
      writeFileSync(lockPath, "999999999"); // a pid nothing on this host runs as — "dead"
      const writeDeps = { env: envDeps };
      const scopeOf = async () => 0;
      const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, scopeOf, writeDeps);
      if (!plan.ok) throw new Error("expected a successful plan even with the lock present — plan never takes the write lock");
      const etag = rulesEtag(envDeps);

      const csrf = createCsrfTokenIssuer();
      const { app, origin, host } = startApp({
        csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
        rulesWrite: {
          enabled: (() => { throw new Error("unused"); }) as any,
          fields: ((id: string, patch: unknown, ifMatch: string, confirm: boolean, planHash: string) => {
            const { writeRuleFields } = require("../../src/rules/rules-write.js") as typeof import("../../src/rules/rules-write.js");
            return writeRuleFields(id, patch as any, ifMatch, confirm, planHash, writeDeps);
          }) as any,
          undo: (() => { throw new Error("unused"); }) as any,
          plan: (() => { throw new Error("unused"); }) as any,
        },
      });
      try {
        const res = await fetch(`${origin}/api/rules/ui-first-rule`, {
          method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
          body: JSON.stringify({ ifMatch: etag, planHash: plan.planHash, query: "project = NEW" }),
        });
        expect(res.status).toBe(503);
        const responseBody = await res.json() as { error: string };
        expect(responseBody.error).toContain(lockPath);
        expect(responseBody.error).toContain(`rm ${lockPath}`);
      } finally { await app.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a LIVE-holder lock (held by a running process — this test's own pid): the HTTP response body's error contains the absolute lock path, status 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-stale-lock-route-"));
    try {
      const { envDeps, lockPath } = realWriteDeps(dir);
      writeFileSync(lockPath, String(process.pid)); // THIS test process's own pid — unambiguously alive
      const writeDeps = { env: envDeps };
      const scopeOf = async () => 0;
      const plan = await planRuleWrite("ui-first-rule", { query: "project = NEW" }, false, scopeOf, writeDeps);
      if (!plan.ok) throw new Error("expected a successful plan even with the lock present — plan never takes the write lock");
      const etag = rulesEtag(envDeps);

      const csrf = createCsrfTokenIssuer();
      const { app, origin, host } = startApp({
        csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true,
        rulesWrite: {
          enabled: (() => { throw new Error("unused"); }) as any,
          fields: ((id: string, patch: unknown, ifMatch: string, confirm: boolean, planHash: string) => {
            const { writeRuleFields } = require("../../src/rules/rules-write.js") as typeof import("../../src/rules/rules-write.js");
            return writeRuleFields(id, patch as any, ifMatch, confirm, planHash, writeDeps);
          }) as any,
          undo: (() => { throw new Error("unused"); }) as any,
          plan: (() => { throw new Error("unused"); }) as any,
        },
      });
      try {
        const res = await fetch(`${origin}/api/rules/ui-first-rule`, {
          method: "PUT", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
          body: JSON.stringify({ ifMatch: etag, planHash: plan.planHash, query: "project = NEW" }),
        });
        expect(res.status).toBe(503);
        const responseBody = await res.json() as { error: string };
        expect(responseBody.error).toContain(lockPath);
      } finally { await app.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
