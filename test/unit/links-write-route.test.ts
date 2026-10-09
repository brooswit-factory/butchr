import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { createCsrfTokenIssuer } from "../../src/web/csrf.js";
import { CSRF_HEADER } from "../../src/web/write-guard.js";
import { createWriteRateLimiter } from "../../src/web/write-rate-limit.js";
import { writeLinkAdd, writeLinkRemove, writeLinkUndo, type LinksWriteOutcome } from "../../src/resources/links-write.js";
import { jsonFileEtag } from "../../src/resources/write-json-file.js";
import { linksApi } from "../../dashboard-app/src/api/links.js";

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

const ACCEPTED: LinksWriteOutcome = { ok: true, added: true, backupId: "20261009T000000Z", etag: "next-etag" };

function stubDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, overrides: { add?: any; remove?: any; undo?: any } = {}, audited: unknown[] = []) {
  return {
    csrf,
    writeGuard: writeGuardDeps(csrf),
    dashboardOriginGuard: { port: 0 },
    peerUidCheck: () => true,
    linksWrite: {
      add: overrides.add ?? (async () => ACCEPTED),
      remove: overrides.remove ?? (async () => ACCEPTED),
      undo: overrides.undo ?? (() => ACCEPTED),
    },
    auditWrite: (e: unknown) => { audited.push(e); },
  };
}

// ---------------------------------------------------------------------------
// Guard battery, parameterized over all THREE write routes — no-Origin,
// wrong-Origin, missing CSRF, wrong Content-Type, and failing peer-UID each
// proven to refuse AND to never reach the underlying write function.
// ---------------------------------------------------------------------------
interface RouteCase {
  label: string;
  path: (port: number) => string;
  body: string;
  writeKey: "add" | "remove" | "undo";
}

const ROUTE_CASES: RouteCase[] = [
  { label: "POST /api/links/add", path: (p) => `http://127.0.0.1:${p}/api/links/add`, body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }), writeKey: "add" },
  { label: "POST /api/links/remove", path: (p) => `http://127.0.0.1:${p}/api/links/remove`, body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }), writeKey: "remove" },
  { label: "POST /api/links/undo/:backupId", path: (p) => `http://127.0.0.1:${p}/api/links/undo/20261009T000000Z`, body: "{}", writeKey: "undo" },
];

for (const rc of ROUTE_CASES) {
  describe(`${rc.label} — write guard go-red cases (full battery)`, () => {
    test("no Origin: 403, write never called, nothing audited", async () => {
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

// GET /api/links sits behind the dashboard-origin + same-UID peer guard
// (review round 1 blocking finding 1) — NOT the full write guard (a GET has
// no body, so no Content-Type/CSRF check applies), same discipline
// `GET /api/daemon/logs`/`GET /api/agents/:issue` already follow.
function readGuardDeps(peerOk = true) {
  return { dashboardOriginGuard: { port: 0 }, peerUidCheck: () => peerOk };
}

const FAKE_LINKS_ENTRY = {
  owner: { provider: "jira-work-item", key: "BUTCHR-1" } as any,
  targets: [{ provider: "github-issue", owner: "o", repo: "r", number: 1 } as any],
};

describe("GET /api/links — write guard go-red cases", () => {
  test("no Origin: 403, linksRead never called", async () => {
    let called = false;
    const { app, host, port } = startApp({ ...readGuardDeps(), linksRead: () => { called = true; return [FAKE_LINKS_ENTRY]; } });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links`, { headers: { host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("wrong Origin (forged): 403, linksRead never called", async () => {
    let called = false;
    const { app, host, port } = startApp({ ...readGuardDeps(), linksRead: () => { called = true; return [FAKE_LINKS_ENTRY]; } });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links`, { headers: { origin: "http://evil.example", host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("failing peer-UID check: 403, linksRead never called", async () => {
    let called = false;
    const { app, origin, host, port } = startApp({ ...readGuardDeps(false), linksRead: () => { called = true; return [FAKE_LINKS_ENTRY]; } });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links`, { headers: { origin, host } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });
});

describe("GET /api/links — behavior", () => {
  test("not configured (no linksRead): 503", async () => {
    const { app, origin, host, port } = startApp(readGuardDeps());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links`, { headers: { origin, host } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: returns every owner->targets entry, formatted as canonical strings, Cache-Control: no-store", async () => {
    const { app, origin, host, port } = startApp({ ...readGuardDeps(), linksRead: () => [FAKE_LINKS_ENTRY] });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links`, { headers: { origin, host } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toEqual({ links: [{ owner: "jira-work-item:BUTCHR-1", targets: ["github-issue:o/r#1"] }] });
    } finally { await app.stop(true); }
  });
});

describe("POST /api/links/add — behavior", () => {
  test("not configured (no linksWrite): 503", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host, port } = startApp({ csrf, writeGuard: writeGuardDeps(csrf), dashboardOriginGuard: { port: 0 }, peerUidCheck: () => true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: write is called with exactly the parsed resource/target, and the outcome is audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, {
      add: async (...args: unknown[]) => { seenArgs = args; return ACCEPTED; },
    }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["jira-work-item:BUTCHR-1", "github-issue:owner/repo#1"]);
      expect(audited.length).toBe(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("accepted");
    } finally { await app.stop(true); }
  });

  test("malformed body (missing target): 400, write never called, AND audited (validation 400s ARE audited)", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let called = false;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { add: async () => { called = true; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1" }),
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
      expect(audited.length).toBe(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });

  test("a refusal from the write function (e.g. jira-project owner) is surfaced verbatim and IS audited as rejected", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    const refusal: LinksWriteOutcome = { ok: false, status: 403, error: "jira-project-owned resource refusal text" };
    const { app, origin, host, port } = startApp(stubDeps(csrf, { add: async () => refusal }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-project:BUTCHR", target: "github-issue:owner/repo#1" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: refusal.error });
      expect(audited.length).toBe(1);
      expect((audited[0] as { outcome: string }).outcome).toBe("rejected");
    } finally { await app.stop(true); }
  });
});

describe("POST /api/links/remove — behavior", () => {
  test("all guards pass: body round-trips, audited as accepted", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { remove: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/remove`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["jira-work-item:BUTCHR-1", "github-issue:owner/repo#1"]);
      expect(audited.length).toBe(1);
    } finally { await app.stop(true); }
  });
});

describe("POST /api/links/undo/:backupId — behavior", () => {
  test("all guards pass: undo is called with the decoded backupId, audited", async () => {
    const csrf = createCsrfTokenIssuer();
    const audited: unknown[] = [];
    let seenId: string | undefined;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { undo: (id: string) => { seenId = id; return ACCEPTED; } }, audited));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/undo/20261009T000000Z`, {
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
// The REAL client's own serialized request body: `dashboard-app/src/api/
// links.ts` is imported directly, with `globalThis.fetch` stubbed to
// capture the exact body the client sends — never a hand-written
// JSON.stringify standing in for it.
// ---------------------------------------------------------------------------
describe("the real dashboard-app client's own wire body, fed to each route's real validator", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("add's real wire body is accepted by POST /api/links/add", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify(ACCEPTED), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await linksApi.add("jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(capturedUrl).toBe("/api/links/add");
    const wireBody = JSON.parse(capturedBody!);
    expect(wireBody).toEqual({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" });

    globalThis.fetch = originalFetch;
    const csrf = createCsrfTokenIssuer();
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { add: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["jira-work-item:BUTCHR-1", "github-issue:owner/repo#1"]);
    } finally { await app.stop(true); }
  });

  test("remove's real wire body is accepted by POST /api/links/remove", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify(ACCEPTED), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await linksApi.remove("jira-work-item:BUTCHR-1", "github-issue:owner/repo#1");
    expect(capturedUrl).toBe("/api/links/remove");
    expect(JSON.parse(capturedBody!)).toEqual({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" });

    globalThis.fetch = originalFetch;
    const csrf = createCsrfTokenIssuer();
    let seenArgs: unknown[] = [];
    const { app, origin, host, port } = startApp(stubDeps(csrf, { remove: async (...a: unknown[]) => { seenArgs = a; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/remove`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenArgs).toEqual(["jira-work-item:BUTCHR-1", "github-issue:owner/repo#1"]);
    } finally { await app.stop(true); }
  });

  test("undo's real wire body (empty object) is accepted by POST /api/links/undo/:backupId", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "client-tok" }), { status: 200, headers: { "content-type": "application/json" } });
      capturedUrl = url;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify(ACCEPTED), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await linksApi.undo("20261009T000000Z");
    expect(capturedUrl).toBe("/api/links/undo/20261009T000000Z");
    expect(JSON.parse(capturedBody!)).toEqual({});

    globalThis.fetch = originalFetch;
    const csrf = createCsrfTokenIssuer();
    let seenId: string | undefined;
    const { app, origin, host, port } = startApp(stubDeps(csrf, { undo: (id: string) => { seenId = id; return ACCEPTED; } }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/undo/20261009T000000Z`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: capturedBody!,
      });
      expect(res.status).toBe(200);
      expect(seenId).toBe("20261009T000000Z");
    } finally { await app.stop(true); }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: both write routes share `checkWriteRateLimit`. A max:1
// limiter lets the first write through and 429s the second — proven with
// an operation that WOULD change the target file if the limiter were
// bypassed, so the test can actually fail if the guard were removed.
// ---------------------------------------------------------------------------
describe("write rate limiting, shared across the links write routes", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "butchr-links-ratelimit-"));
    path = join(dir, "links.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function realDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>, writeRateLimit: ReturnType<typeof createWriteRateLimiter>) {
    const lastUiWrite = { value: null };
    const writeDeps = { path: () => path, lastUiWrite };
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      writeRateLimit,
      linksWrite: {
        add: (resource: string, target: string) => writeLinkAdd(writeDeps, resource, target),
        remove: (resource: string, target: string) => writeLinkRemove(writeDeps, resource, target),
        undo: (backupId: string) => writeLinkUndo(writeDeps, backupId),
      },
      auditWrite: () => { /* not asserted here */ },
    };
  }

  test("POST /api/links/add: first write lands, second is 429 with Retry-After, write never reaches the file", async () => {
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(first.status).toBe(200);
      const afterFirst = readFileSync(path, "utf8");
      expect(JSON.parse(afterFirst).links["jira-work-item:BUTCHR-1"]).toEqual(["github-issue:owner/repo#1"]);

      // This WOULD add a second target if the limiter were bypassed.
      const second = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "webpage:https://example.com/x" }),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(path, "utf8")).toBe(afterFirst);
    } finally { await app.stop(true); }
  });

  test("POST /api/links/remove: first write lands, second is 429 with Retry-After, file stays as the first write left it", async () => {
    // Pre-seed two links directly on disk (never through the rate-limited
    // route) so neither write below spends budget on setup.
    writeFileSync(path, `${JSON.stringify({ v: 1, links: { "jira-work-item:BUTCHR-1": ["github-issue:owner/repo#1"], "jira-work-item:BUTCHR-2": ["webpage:https://example.com/x"] } }, null, 2)}\n`);
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/links/remove`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(first.status).toBe(200);
      const afterFirst = readFileSync(path, "utf8");
      expect(JSON.parse(afterFirst).links["jira-work-item:BUTCHR-1"]).toBeUndefined();
      expect(JSON.parse(afterFirst).links["jira-work-item:BUTCHR-2"]).toEqual(["webpage:https://example.com/x"]);

      // This WOULD remove the second link if the limiter were bypassed.
      const second = await fetch(`http://127.0.0.1:${port}/api/links/remove`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-2", target: "webpage:https://example.com/x" }),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(path, "utf8")).toBe(afterFirst); // BUTCHR-2's link still present, not removed
    } finally { await app.stop(true); }
  });

  test("POST /api/links/undo/:backupId: refused past the budget consumed by a prior write, undo never runs", async () => {
    const csrf = createCsrfTokenIssuer();
    const writeRateLimit = createWriteRateLimiter({ windowMs: 10_000, max: 1 });
    const { app, origin, host, port } = startApp(realDeps(csrf, writeRateLimit));
    try {
      const write = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "github-issue:owner/repo#1" }),
      });
      expect(write.status).toBe(200);
      const backupId = (await write.json() as { backupId: string | null }).backupId;
      const afterWrite = readFileSync(path, "utf8");

      const undo = await fetch(`http://127.0.0.1:${port}/api/links/undo/${backupId}`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: "{}",
      });
      expect(undo.status).toBe(429);
      expect(undo.headers.get("retry-after")).toBeTruthy();
      expect(readFileSync(path, "utf8")).toBe(afterWrite);
    } finally { await app.stop(true); }
  });
});

describe("end-to-end through real HTTP against the real write path: refusals write NOTHING", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "butchr-links-route-e2e-"));
    path = join(dir, "links.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function realDeps(csrf: ReturnType<typeof createCsrfTokenIssuer>) {
    const lastUiWrite = { value: null };
    const writeDeps = { path: () => path, lastUiWrite };
    return {
      csrf,
      writeGuard: writeGuardDeps(csrf),
      dashboardOriginGuard: { port: 0 },
      peerUidCheck: () => true,
      linksWrite: {
        add: (resource: string, target: string) => writeLinkAdd(writeDeps, resource, target),
        remove: (resource: string, target: string) => writeLinkRemove(writeDeps, resource, target),
        undo: (backupId: string) => writeLinkUndo(writeDeps, backupId),
      },
      auditWrite: () => { /* not asserted here */ },
    };
  }

  test("a jira-project-owned add reaches the real write function via HTTP and nothing is written to disk", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host, port } = startApp(realDeps(csrf));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-project:BUTCHR", target: "github-issue:owner/repo#1" }),
      });
      expect(res.status).toBe(403);
      expect(() => readFileSync(path, "utf8")).toThrow(); // never created
    } finally { await app.stop(true); }
  });

  test("a self-link add reaches the real write function via HTTP and nothing is written to disk", async () => {
    const csrf = createCsrfTokenIssuer();
    const { app, origin, host, port } = startApp(realDeps(csrf));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/links/add`, {
        method: "POST", headers: { origin, host, "content-type": "application/json", [CSRF_HEADER]: csrf.token },
        body: JSON.stringify({ resource: "jira-work-item:BUTCHR-1", target: "jira-work-item:BUTCHR-1" }),
      });
      expect(res.status).toBe(400);
      expect(() => readFileSync(path, "utf8")).toThrow(); // never created
    } finally { await app.stop(true); }
  });
});
