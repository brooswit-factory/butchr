import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import { createWriteRateLimiter } from "../../src/web/write-rate-limit.js";
import { writeSessionDefinitionFields, writeSessionDefinitionFrozen, writeSessionDefinitionUndo, type SessionDefinitionsWriteOutcome } from "../../src/resources/session-definitions-write.js";
import { jsonFileEtag } from "../../src/resources/write-json-file.js";
import { sessionDefinitionsApi } from "../../dashboard-app/src/api/session-definitions.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return { state: unused, open: unused, openPane: unused, health: unused, dashboard: unused, header: unused, resourceLink: unused, configInventory: unused, ...overrides } as ViewDeps;
}

function startApp(deps: Partial<ViewDeps>) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = (app.server as any).port as number;
  if (deps.dashboardOriginGuard) deps.dashboardOriginGuard.port = port;
  if (deps.writeGuard) deps.writeGuard.dashboardOriginGuard.port = port;
  return { app, port, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

function writeGuardDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, peerOk = true) {
  return { dashboardOriginGuard: { port: 0 }, peerUidCheck: () => peerOk, csrf };
}

const ACCEPTED: SessionDefinitionsWriteOutcome = { ok: true, requiresConfirm: false, backupId: "20261009T000000Z", etag: "next-etag" };

function stubDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, overrides: { fields?: any; frozen?: any; undo?: any } = {}, audited: unknown[] = []) {
  return {
    csrf,
    writeGuard: writeGuardDeps(csrf),
    dashboardOriginGuard: { port: 0 },
    peerUidCheck: () => true,
    sessionDefinitionsWrite: {
      fields: overrides.fields ?? (async () => ACCEPTED),
      frozen: overrides.frozen ?? (async () => ACCEPTED),
      undo: overrides.undo ?? (() => ACCEPTED),
    },
    auditWrite: (e: unknown) => { audited.push(e); },
  };
}

// ---------------------------------------------------------------------------
// Guard battery, parameterized over all THREE new routes — no-Origin,
// wrong-Origin, missing CSRF, wrong Content-Type, and failing peer-UID each
// proven to refuse AND to never reach the underlying write function, for
// EVERY route, not just /fields (review round 1 blocking finding 1).
// ---------------------------------------------------------------------------
interface RouteCase {
  label: string;
  path: (port: number) => string;
  body: string;
  writeKey: "fields" | "frozen" | "undo";
}

const ROUTE_CASES: RouteCase[] = [
  { label: "POST /api/session-definitions/:name/fields", path: (p) => `http://127.0.0.1:${p}/api/session-definitions/a.json/fields`, body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }), writeKey: "fields" },
  { label: "POST /api/session-definitions/:name/frozen", path: (p) => `http://127.0.0.1:${p}/api/session-definitions/a.json/frozen`, body: JSON.stringify({ frozen: true, ifMatch: "x" }), writeKey: "frozen" },
  { label: "POST /api/session-definitions/undo/:backupId", path: (p) => `http://127.0.0.1:${p}/api/session-definitions/undo/20261009T000000Z`, body: "{}", writeKey: "undo" },
];

for (const rc of ROUTE_CASES) {
  describe(`${rc.label} — write guard go-red cases (full battery)`, () => {
    test("no Origin: 403, write never called, nothing audited (a guard refusal writes no audit line)", async () => {
      const csrf = createCsrfTokenIssuer();
      let called = false;
      const audited: unknown[] = [];
      const { app, host, port } = startApp(stubDeps(csrf, { [rc.writeKey]: (..._a: unknown[]) => { called = true; return ACCEPTED; } }, audited));
      try {
        const res = await fetch(rc.path(port), { method: "POST", headers: { host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: rc.body });
        expect(res.status).toBe(403);
        expect(called).toBe(false);
        expect(audited.length).toBe(0);
      } finally { await app.stop(true); }
    });

    test("wrong Origin (forged): 403, write never called, nothing audited", async () => {
      const csrf = createCsrfTokenIssuer();
      let called = false;
      const audited: unknown[] = [];
      const { app, host, port } = startApp(stubDeps(csrf, { [rc.writeKey]: (..._a: unknown[]) => { called = true; return ACCEPTED; } }, audited));
      try {
        const res = await fetch(rc.path(port), { method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: rc.body });
        expect(res.status).toBe(403);
        expect(called).toBe(false);
        expect(audited.length).toBe(0);
      } finally { await app.stop(true); }
    });

    test("missing CSRF header: 403, write never called, nothing audited", async () => {
      const csrf = createCsrfTokenIssuer();
      let called = false;
      const audited: unknown[] = [];
      const { app, origin, host, port } = startApp(stubDeps(csrf, { [rc.writeKey]: (..._a: unknown[]) => { called = true; return ACCEPTED; } }, audited));
      try {
        const res = await fetch(rc.path(port), { method: "POST", headers: { origin, host, "content-type": "application/json" }, body: rc.body });
        expect(res.status).toBe(403);
        expect(called).toBe(false);
        expect(audited.length).toBe(0);
      } finally { await app.stop(true); }
    });

    test("wrong Content-Type: 415, write never called, nothing audited", async () => {
      const csrf = createCsrfTokenIssuer();
      let called = false;
      const audited: unknown[] = [];
      const { app, origin, host, port } = startApp(stubDeps(csrf, { [rc.writeKey]: (..._a: unknown[]) => { called = true; return ACCEPTED; } }, audited));
      try {
        const res = await fetch(rc.path(port), { method: "POST", headers: { origin, host, "content-type": "text/plain", [CSRF_HEADER]: csrf.token }, body: rc.body });
        expect(res.status).toBe(415);
        expect(called).toBe(false);
        expect(audited.length).toBe(0);
      } finally { await app.stop(true); }
    });

    test("failing peer-UID check: 403, write never called, nothing audited", async () => {
      const csrf = createCsrfTokenIssuer();
      let called = false;
      const audited: unknown[] = [];
      const deps = stubDeps(csrf, { [rc.writeKey]: (..._a: unknown[]) => { called = true; return ACCEPTED; } }, audited);
      deps.writeGuard = writeGuardDeps(csrf, false);
      const { app, origin, host, port } = startApp(deps);
      try {
        const res = await fetch(rc.path(port), { method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token }, body: rc.body });
        expect(res.status).toBe(403);
        expect(called).toBe(false);
        expect(audited.length).toBe(0);
      } finally { await app.stop(true); }
    });
  });
}

describe("POST /api/session-definitions/:name/fields — behavior", () => {
  test("not configured (no sessionDefinitionsWrite): 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host, port } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: write is called with exactly the parsed fields, and the outcome is audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, {
      fields: async (...args: unknown[]) => { seenArgs = args; return ACCEPTED; },
    }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 77, effort: 60 }, ifMatch: "etag-1", confirm: true }),
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["a.json", { modelPower: 77, effort: 60 }, "etag-1", true]);
      expect(audited.length).toBe(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("a requiresConfirm outcome is returned verbatim and is NOT audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const preview: SessionDefinitionsWriteOutcome = { ok: true, requiresConfirm: true, confirmReason: "risky-permission", preview: [{ field: "lizardMode", oldValue: null, newValue: true, consequence: "x" }] };
    const { app, origin, host, port } = startApp(stubDeps(csrf, { fields: async () => preview }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { lizardMode: true }, ifMatch: "etag-1", confirm: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(preview);
      expect(audited.length).toBe(0);
    } finally { await app.stop(true); }
  });

  test("malformed body (missing ifMatch): 400, write never called, AND audited (criterion: validation 400s ARE audited)", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let called = false;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 1 } }),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
      expect(audited.length).toBe(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });
});

describe("POST /api/session-definitions/:name/frozen — behavior", () => {
  test("all guards pass: body round-trips, audited as accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { frozen: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/frozen`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ frozen: true, ifMatch: "etag-1" }),
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["a.json", true, "etag-1"]);
      expect(audited.length).toBe(1);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/session-definitions/undo/:backupId — behavior", () => {
  test("all guards pass: undo is called with the decoded backupId, audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenId: string | undefined;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { undo: (id: string) => { seenId = id; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/undo/20261009T000000Z`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(seenId).toBe("20261009T000000Z");
      expect(audited.length).toBe(1);
    } finally { await app.stop(true); }
  });
});

// ---------------------------------------------------------------------------
// The REAL client's own serialized request body (review round 1 blocking
// finding 2): `dashboard-app/src/api/session-definitions.ts` is imported
// directly, with `globalThis.fetch` stubbed to (a) answer `GET /api/session`
// with a CSRF token and (b) capture the exact body/URL the client sends for
// the real write call — never a hand-written JSON.stringify standing in for
// it. That captured body is then POSTed to the REAL route (via `startApp`),
// proving the server's own validator accepts exactly what the client really
// serializes, not a believed-to-match approximation of it.
// ---------------------------------------------------------------------------
describe("the real dashboard-app client's own wire body, fed to each route's real validator", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("patchFields' real wire body is accepted by POST /api/session-definitions/:name/fields", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, requiresConfirm: false, backupId: null, etag: "e" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await sessionDefinitionsApi.patchFields("a.json", { modelPower: 80, effort: 70 }, "etag-1", true);
    expect(capturedUrl).toBe("/api/session-definitions/a.json/fields");
    expect(capturedBody).toBeDefined();
    const wireBody = JSON.parse(capturedBody!);
    expect(wireBody).toEqual({ patch: { modelPower: 80, effort: 70 }, ifMatch: "etag-1", confirm: true });

    globalThis.fetch = originalFetch; // the stub above must not also intercept the REAL request below
    const csrf = createCsrfTokenIssuer();
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { fields: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["a.json", { modelPower: 80, effort: 70 }, "etag-1", true]);
    } finally { await app.stop(true); }
  });

  test("setFrozen's real wire body is accepted by POST /api/session-definitions/:name/frozen", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, requiresConfirm: false, backupId: null, etag: "e" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await sessionDefinitionsApi.setFrozen("a.json", true, "etag-2");
    expect(capturedUrl).toBe("/api/session-definitions/a.json/frozen");
    const wireBody = JSON.parse(capturedBody!);
    expect(wireBody).toEqual({ frozen: true, ifMatch: "etag-2" });

    globalThis.fetch = originalFetch; // the stub above must not also intercept the REAL request below
    const csrf = createCsrfTokenIssuer();
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { frozen: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/frozen`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["a.json", true, "etag-2"]);
    } finally { await app.stop(true); }
  });

  test("undo's real wire body (empty object) is accepted by POST /api/session-definitions/undo/:backupId", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, requiresConfirm: false, backupId: null, etag: "e" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await sessionDefinitionsApi.undo("20261009T000000Z");
    expect(capturedUrl).toBe("/api/session-definitions/undo/20261009T000000Z");
    expect(JSON.parse(capturedBody!)).toEqual({});

    globalThis.fetch = originalFetch; // the stub above must not also intercept the REAL request below
    const csrf = createCsrfTokenIssuer();
    let seenId: string | undefined;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { undo: (id: string) => { seenId = id; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/undo/20261009T000000Z`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenId).toBe("20261009T000000Z");
    } finally { await app.stop(true); }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (review round 1 blocking finding 3): all three routes share
// `checkWriteRateLimit`. A max:1 limiter lets the first write through and
// 429s the second — proven with a patch that WOULD change the target file
// if the limiter were bypassed, so the test can actually fail if the guard
// were removed.
// ---------------------------------------------------------------------------
describe("write rate limiting, shared across all three routes", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-session-defs-ratelimit-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function realDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, writeRateLimit: ReturnType<typeof createWriteRateLimiter>) {
    const lastUiWrite = { value: null };
    const store = { async read() { return { frozen: false }; }, async set() { /* no-op */ } };
    const writeDeps = { dir: () => dir, store, lastUiWrite };
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      writeRateLimit,
      sessionDefinitionsWrite: {
        fields: (name: string, patch: Record<string, unknown>, ifMatch: string, confirm: boolean) => writeSessionDefinitionFields(writeDeps, name, patch, ifMatch, confirm),
        frozen: (name: string, frozen: boolean, ifMatch: string) => writeSessionDefinitionFrozen(writeDeps, name, frozen, ifMatch),
        undo: (backupId: string) => writeSessionDefinitionUndo(writeDeps, backupId),
      },
      auditWrite: () => { /* not asserted here */ },
    };
  }

  const DEF_TEXT = `${JSON.stringify({ workingDirectory: "/repo", brief: "b", vendor: "claude", modelPower: 50, effort: 50, permissionMode: "default", frozen: false }, null, 2)}\n`;

  test("POST /api/session-definitions/:name/fields: first write lands, second is 429 with Retry-After, write never reaches the file", async () => {
    writeFileSync(join(dir, "a.json"), DEF_TEXT);
    const etag1 = jsonFileEtag(join(dir, "a.json"));
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 91 }, ifMatch: etag1, confirm: false }),
      });
      expect(first.status).toBe(200);
      const afterFirst = readFileSync(join(dir, "a.json"), "utf8");
      expect(JSON.parse(afterFirst).modelPower).toBe(91);
      const etag2 = jsonFileEtag(join(dir, "a.json"));

      // This patch WOULD change modelPower to 92 if the limiter were bypassed.
      const second = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 92 }, ifMatch: etag2, confirm: false }),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(afterFirst); // still 91, not 92
    } finally { await app.stop(true); }
  });

  test("POST /api/session-definitions/:name/frozen: first write lands, second is 429, file stays as the first write left it", async () => {
    writeFileSync(join(dir, "a.json"), DEF_TEXT);
    const etag1 = jsonFileEtag(join(dir, "a.json"));
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/frozen`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ frozen: true, ifMatch: etag1 }),
      });
      expect(first.status).toBe(200);
      const afterFirst = readFileSync(join(dir, "a.json"), "utf8");
      expect(JSON.parse(afterFirst).frozen).toBe(true);
      const etag2 = jsonFileEtag(join(dir, "a.json"));

      // This WOULD flip frozen back to false if the limiter were bypassed.
      const second = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/frozen`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ frozen: false, ifMatch: etag2 }),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(afterFirst); // still frozen: true
    } finally { await app.stop(true); }
  });

  test("POST /api/session-definitions/undo/:backupId: first call is 429'd past the budget consumed by a prior write, undo never runs", async () => {
    writeFileSync(join(dir, "a.json"), DEF_TEXT);
    const etag1 = jsonFileEtag(join(dir, "a.json"));
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const write = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 95 }, ifMatch: etag1, confirm: false }),
      });
      expect(write.status).toBe(200);
      const backupId = (await write.json() as { backupId: string }).backupId;
      const afterWrite = readFileSync(join(dir, "a.json"), "utf8");

      // Budget (max: 1) already spent by the write above — this undo
      // attempt, which WOULD restore the pre-write bytes if it ran, must be
      // refused by the limiter instead.
      const undo = await fetch(`http://127.0.0.1:${port}/api/session-definitions/undo/${backupId}`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(undo.status).toBe(429);
      expect(undo.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(afterWrite); // not restored
    } finally { await app.stop(true); }
  });
});

describe("end-to-end through real HTTP against the real write path: refusals write NOTHING", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "butchr-session-defs-route-e2e-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function realDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>) {
    const lastUiWrite = { value: null };
    const store = { async read() { return { frozen: false }; }, async set() { /* no-op */ } };
    const writeDeps = { dir: () => dir, store, lastUiWrite };
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      sessionDefinitionsWrite: {
        fields: (name: string, patch: Record<string, unknown>, ifMatch: string, confirm: boolean) => writeSessionDefinitionFields(writeDeps, name, patch, ifMatch, confirm),
        frozen: (name: string, frozen: boolean, ifMatch: string) => writeSessionDefinitionFrozen(writeDeps, name, frozen, ifMatch),
        undo: (backupId: string) => writeSessionDefinitionUndo(writeDeps, backupId),
      },
      auditWrite: () => { /* not asserted here */ },
    };
  }

  test("a disallowed field reaches the real write function via HTTP and the file on disk is untouched", async () => {
    const text = `${JSON.stringify({ workingDirectory: "/repo", brief: "b", vendor: "claude", modelPower: 50, effort: 50, permissionMode: "default", frozen: false }, null, 2)}\n`;
    writeFileSync(join(dir, "a.json"), text);
    const etag = jsonFileEtag(join(dir, "a.json"));
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host, port } = startApp(realDeps(csrf));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { workingDirectory: "/evil" }, ifMatch: etag, confirm: true }),
      });
      expect(res.status).toBe(403);
      expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(text);
    } finally { await app.stop(true); }
  });
});
