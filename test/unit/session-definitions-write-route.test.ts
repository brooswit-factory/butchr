import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import { writeSessionDefinitionFields, writeSessionDefinitionFrozen, writeSessionDefinitionUndo, type SessionDefinitionsWriteOutcome } from "../../src/resources/session-definitions-write.js";
import { jsonFileEtag } from "../../src/resources/write-json-file.js";

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

describe("POST /api/session-definitions/:name/fields — write guard go-red cases", () => {
  test("forged Origin: 403, write never called, nothing audited", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const audited: unknown[] = [];
    const { app, host, port } = startApp(stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
      expect(audited.length).toBe(0);
    } finally { await app.stop(true); }
  });

  test("missing Origin entirely: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host, port } = startApp(stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("missing CSRF header: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json" },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong content-type: 415, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "text/plain", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(415);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("failing peer-uid check: 403, write never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    // `peerOk` is the write-guard's OWN peer check (passed into
    // `writeGuardDeps` below) — the top-level `peerUidCheck` field on
    // `ViewDeps` is a SEPARATE closure used only by the GET routes' own
    // guard, so mutating it after the fact (as the top-level `peerUidCheck`
    // literal alone) would never reach `checkWriteGuard` at all.
    const deps = stubDeps(csrf, { fields: async () => { called = true; return ACCEPTED; } });
    deps.writeGuard = writeGuardDeps(csrf, false);
    const { app, origin, host, port } = startApp(deps);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/fields`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ patch: { modelPower: 90 }, ifMatch: "x", confirm: false }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      await app.stop(true);
    }
  });

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

  test("all guards pass: the real client's own serialized request body round-trips through the route's own validator, write is called with exactly the parsed fields, and the outcome is audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, {
      fields: async (...args: unknown[]) => { seenArgs = args; return ACCEPTED; },
    }, audited));
    try {
      // Exactly the shape `dashboard-app/src/api/session-definitions.ts`'s
      // `patchFields` sends: `{ patch, ifMatch, confirm }`.
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

describe("POST /api/session-definitions/:name/frozen — write guard go-red cases", () => {
  test("forged Origin: 403, never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host, port } = startApp(stubDeps(csrf, { frozen: async () => { called = true; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/a.json/frozen`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ frozen: true, ifMatch: "x" }),
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

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

describe("POST /api/session-definitions/undo/:backupId — write guard go-red cases", () => {
  test("forged Origin: 403, never called", async () => {
    const csrf = createCsrfTokenIssuer();
    let called = false;
    const { app, host, port } = startApp(stubDeps(csrf, { undo: () => { called = true; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-definitions/undo/20261009T000000Z`, {
        method: "POST", headers: { origin: "http://evil.example", host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

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
