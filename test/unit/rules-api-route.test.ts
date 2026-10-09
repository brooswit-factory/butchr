import { describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import type { QueryAgentInventory } from "../../src/agents/query-agent-inventory.js";
import type { RulesPreviewResult } from "../../src/web/rules-preview.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

const PORT = 7718;
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

const emptyInventory: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };

// `server.requestIP(request)` (used to extract the client address+port for
// the peer-uid check — PR #642 review round 2, G2: BOTH `/api/rules` and
// `/api/rules/:id/preview` now require it) is only populated by a REAL Bun
// server — `app.handle()` (used by the guard-only tests below, which never
// reach the peer-uid check) runs with no listening server at all, so
// `server` is `null` there. Tests that need to get PAST the peer-uid check
// actually `.listen()` and hit the route over real HTTP, same precedent as
// `test/unit/mcp-loopback.test.ts` and `test/unit/pty-attach-route.test.ts`.
// The guard's port is supplied as a MUTABLE object (`checkDashboardOrigin`
// reads it fresh per-request) so each test can listen on an OS-assigned
// port first and only then tell the guard what that port turned out to be
// — no hardcoded port, no race.
function startApp(deps: Partial<ViewDeps> & { dashboardOriginGuard: { port: number } }) {
  const app = liveView(fakeMcp, baseDeps(deps));
  app.listen(0);
  const port = app.server?.port ?? 0;
  deps.dashboardOriginGuard.port = port;
  return { app, port, headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } };
}

describe("GET /api/rules", () => {
  test("no dashboardOriginGuard configured: 503, never reached rulesFileState", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ rulesFileState: async () => { called = true; return { path: "x", rules: [], error: null, mtime: null, fileEtag: "x" }; } }));
    const res = await app.handle(new Request("http://local/api/rules", { headers: { origin: ORIGIN, host: HOST } }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("missing Origin: 403, guard runs before the peer-uid check or rulesFileState are ever called", async () => {
    let checked = false;
    let called = false;
    const app = liveView(fakeMcp, baseDeps({
      dashboardOriginGuard: { port: PORT },
      peerUidCheck: () => { checked = true; return true; },
      rulesFileState: async () => { called = true; return { path: "x", rules: [], error: null, mtime: null, fileEtag: "x" }; },
    }));
    const res = await app.handle(new Request("http://local/api/rules", { headers: { host: HOST } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin required" });
    expect(checked).toBe(false);
    expect(called).toBe(false);
  });

  test("wrong Origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
    const res = await app.handle(new Request("http://local/api/rules", { headers: { origin: "http://evil.example", host: HOST } }));
    expect(res.status).toBe(403);
  });

  // PR #642 review round 2, G2: `/api/rules` reveals rule shapes/queries to
  // any local user who can reach loopback, so it now carries the SAME
  // same-UID peer check `/api/rules/:id/preview` always had — these need a
  // real listening server (see `startApp`'s own header) since the guard
  // passes with a real Origin/Host and the peer-uid check is next.
  test("allowed origin, no peerUidCheck configured: 503, never reaches rulesFileState", async () => {
    let called = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      rulesFileState: async () => { called = true; return { path: "x", rules: [], error: null, mtime: null, fileEtag: "x" }; },
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(503);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck rejects: 403, never reaches rulesFileState", async () => {
    let called = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => false,
      rulesFileState: async () => { called = true; return { path: "x", rules: [], error: null, mtime: null, fileEtag: "x" }; },
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "peer uid check failed" });
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck is called with the client's own address+port (the full endpoint, not a bare port — G3)", async () => {
    let received: { address: string; port: number } | undefined;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: (client) => { received = client; return true; },
      configInventory: async () => emptyInventory,
      getRulesSourceEtag: () => "x",
      rulesFileState: async () => ({ path: "/rules.json", rules: [], error: null, mtime: null, fileEtag: "x" }),
    });
    try {
      await fetch(`${headers.origin}/api/rules`, { headers });
      expect(received).toBeDefined();
      expect(typeof received!.address).toBe("string");
      expect(typeof received!.port).toBe("number");
    } finally { await app.stop(true); }
  });

  test("peerUidCheck passes but no rulesFileState dep configured: 503", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      configInventory: async () => emptyInventory,
      getRulesSourceEtag: () => "x",
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck passes, rulesFileState configured but no getRulesSourceEtag dep: 503", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      configInventory: async () => emptyInventory,
      rulesFileState: async () => ({ path: "/rules.json", rules: [], error: null, mtime: null, fileEtag: "x" }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  // FACTORY-657: `RulesHolder.getSourceEtag()` returns `undefined` only for
  // a holder that has never loaded any file at all — this route's data is
  // meaningless without it, so that case fails closed the same as the dep
  // being entirely absent.
  test("getRulesSourceEtag returns undefined: 503", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      configInventory: async () => emptyInventory,
      getRulesSourceEtag: () => undefined,
      rulesFileState: async () => ({ path: "/rules.json", rules: [], error: null, mtime: null, fileEtag: "x" }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: 200, Cache-Control: no-store, body built from rulesFileState + configInventory + rulesSourceEtag", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      configInventory: async () => ({
        rules: [{
          kind: "rule", id: "triage", resourceProvider: "jira-work", query: "project = X", enabled: true,
          execution: "swarm", account: "none", role: "worker", agentPreferences: [], linkedEventing: false,
          mcpServerNames: [], staffed: true, reason: null,
        }],
        sessionDefinitions: [], errors: [],
      }),
      getRulesSourceEtag: () => "deadbeef",
      rulesFileState: async () => ({
        path: "/rules.json",
        rules: [{ id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = X", brief: "do the thing", execution: "swarm", account: "none", role: "worker" } as any],
        error: null,
        mtime: "2026-10-05T12:00:00.000Z",
        fileEtag: "deadbeef",
      }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json() as any;
      expect(body.path).toBe("/rules.json");
      expect(body.mtime).toBe("2026-10-05T12:00:00.000Z");
      expect(body.sourceEtag).toBe("deadbeef");
      expect(body.fileEtag).toBe("deadbeef");
      expect(body.stale).toBe(false);
      expect(body.valid).toBe(true);
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].id).toBe("triage");
      expect(body.rules[0].briefExcerpt).toBe("do the thing");
      expect("title" in body.rules[0]).toBe(false);
      expect("maxAgents" in body.rules[0]).toBe(false);
    } finally { await app.stop(true); }
  });

  // PR #642 review round 2, G1: a STALE startup `rules` array paired with a
  // FRESH file etag would let the UI write against a listing it never saw
  // — `stale` is how the UI tells the two apart.
  test("rulesSourceEtag !== rulesFileState().fileEtag: stale is true in the response", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      configInventory: async () => emptyInventory,
      getRulesSourceEtag: () => "startup-etag",
      rulesFileState: async () => ({ path: "/rules.json", rules: [], error: null, mtime: null, fileEtag: "current-file-etag" }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules`, { headers });
      const body = await res.json() as any;
      expect(body.sourceEtag).toBe("startup-etag");
      expect(body.fileEtag).toBe("current-file-etag");
      expect(body.stale).toBe(true);
    } finally { await app.stop(true); }
  });

  // PR #642 review round 1: a REAL browser's own same-origin
  // `fetch("/api/rules")` sends NO Origin at all (Fetch spec stamps it only
  // for non-GET/HEAD, or cross-origin) — this is the actual failure mode
  // the review caught (the original guard 403'd this real case). `Sec-
  // Fetch-Site: same-origin` is what the real dashboard's own fetch always
  // carries in that case; a forged/absent one must still be refused.
  describe("the real-browser same-origin case (no Origin header at all)", () => {
    test("no Origin + Sec-Fetch-Site: same-origin + exact Host: 200, same as a present-Origin request", async () => {
      const guard = { port: 0 };
      const app = liveView(fakeMcp, baseDeps({
        dashboardOriginGuard: guard,
        peerUidCheck: () => true,
        configInventory: async () => emptyInventory,
        getRulesSourceEtag: () => "x",
        rulesFileState: async () => ({ path: "/rules.json", rules: [], error: null, mtime: null, fileEtag: "x" }),
      }));
      app.listen(0);
      const port = app.server?.port ?? 0;
      guard.port = port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/rules`, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
        expect(res.status).toBe(200);
      } finally { await app.stop(true); }
    });
    test("no Origin and no Sec-Fetch-Site at all: 403 (not the real-browser case — no credential at all)", async () => {
      const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
      const res = await app.handle(new Request("http://local/api/rules", { headers: { host: HOST } }));
      expect(res.status).toBe(403);
    });
    test("no Origin + Sec-Fetch-Site: cross-site: 403", async () => {
      const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
      const res = await app.handle(new Request("http://local/api/rules", { headers: { host: HOST, "sec-fetch-site": "cross-site" } }));
      expect(res.status).toBe(403);
    });
    test("no Origin + Sec-Fetch-Site: same-site (not same-origin): 403", async () => {
      const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
      const res = await app.handle(new Request("http://local/api/rules", { headers: { host: HOST, "sec-fetch-site": "same-site" } }));
      expect(res.status).toBe(403);
    });
    test("no Origin + Sec-Fetch-Site: same-origin but WRONG Host: 403", async () => {
      const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: { port: PORT } }));
      const res = await app.handle(new Request("http://local/api/rules", { headers: { host: "127.0.0.1:9999", "sec-fetch-site": "same-origin" } }));
      expect(res.status).toBe(403);
    });
  });
});

describe("GET /api/rules/catalog", () => {
  test("no dashboardOriginGuard configured: 503, never reached rulesCatalog", async () => {
    let called = false;
    const app = liveView(fakeMcp, baseDeps({ rulesCatalog: () => { called = true; return []; } }));
    const res = await app.handle(new Request("http://local/api/rules/catalog", { headers: { origin: ORIGIN, host: HOST } }));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("forged Origin: 403, never reached peerUidCheck or rulesCatalog", async () => {
    let checked = false;
    let called = false;
    const app = liveView(fakeMcp, baseDeps({
      dashboardOriginGuard: { port: PORT },
      peerUidCheck: () => { checked = true; return true; },
      rulesCatalog: () => { called = true; return []; },
    }));
    const res = await app.handle(new Request("http://local/api/rules/catalog", { headers: { origin: "http://evil.example", host: HOST } }));
    expect(res.status).toBe(403);
    expect(checked).toBe(false);
    expect(called).toBe(false);
  });

  test("origin/host pass but peer-uid check fails: 403, never reached rulesCatalog", async () => {
    const guard = { port: 0 };
    let called = false;
    const app = liveView(fakeMcp, baseDeps({
      dashboardOriginGuard: guard,
      peerUidCheck: () => false,
      rulesCatalog: () => { called = true; return []; },
    }));
    app.listen(0);
    const port = app.server?.port ?? 0;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rules/catalog`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally { await app.stop(true); }
  });

  test("no rulesCatalog dep configured (guards pass): 503", async () => {
    const guard = { port: 0 };
    const app = liveView(fakeMcp, baseDeps({ dashboardOriginGuard: guard, peerUidCheck: () => true }));
    app.listen(0);
    const port = app.server?.port ?? 0;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rules/catalog`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("all guards pass: 200, returns the catalog verbatim, no-store", async () => {
    const guard = { port: 0 };
    const fakeCatalog = [{ harness: "claude", models: ["sonnet"], allowsCustomModel: true, efforts: ["low"], permissionModes: ["default"] }];
    const app = liveView(fakeMcp, baseDeps({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesCatalog: () => fakeCatalog as never,
    }));
    app.listen(0);
    const port = app.server?.port ?? 0;
    guard.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rules/catalog`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      // FACTORY-817: `capacityRoles` is served alongside `harnesses` — not
      // sourced from `deps.rulesCatalog()` (that dep is per-harness only),
      // but computed straight from `AGENT_ROLES`/`CAPACITY_ROLE_DEFAULT`
      // (`src/rules/rule-form-catalog.ts`), so it is present regardless of
      // what `fakeCatalog` above contains.
      expect(body).toEqual({ harnesses: fakeCatalog, capacityRoles: { values: ["worker", "sentinel"], default: "worker" } });
    } finally { await app.stop(true); }
  });
});

describe("GET /api/rules/:id/preview", () => {
  test("no dashboardOriginGuard: 503, never checks peer uid or previews", async () => {
    let checked = false;
    const app = liveView(fakeMcp, baseDeps({ peerUidCheck: () => { checked = true; return true; } }));
    app.listen(0);
    const port = app.server!.port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rules/triage/preview`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(503);
      expect(checked).toBe(false);
    } finally { await app.stop(true); }
  });

  test("missing Origin: 403, before the peer-uid check ever runs", async () => {
    let checked = false;
    const guard = { port: 0 };
    const { app, port } = startApp({ dashboardOriginGuard: guard, peerUidCheck: () => { checked = true; return true; } });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rules/triage/preview`, { headers: { host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(403);
      expect(checked).toBe(false);
    } finally { await app.stop(true); }
  });

  test("allowed origin but no peerUidCheck configured: 503", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({ dashboardOriginGuard: guard });
    try {
      const res = await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(res.status).toBe(503);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck rejects: 403, never calls rulesPreview", async () => {
    let previewed = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => false,
      rulesPreview: async () => { previewed = true; return { ok: true, keys: [], total: 0, cap: 50, warning: null } as RulesPreviewResult; },
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(res.status).toBe(403);
      expect(previewed).toBe(false);
    } finally { await app.stop(true); }
  });

  test("peerUidCheck is called with the client's own address+port (the full endpoint, not a bare port — G3)", async () => {
    let received: { address: string; port: number } | undefined;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: (client) => { received = client; return true; },
      rulesPreview: async () => ({ ok: true, keys: [], total: 0, cap: 50, warning: null }),
    });
    try {
      await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(received).toBeDefined();
      expect(typeof received!.address).toBe("string");
      expect(typeof received!.port).toBe("number");
    } finally { await app.stop(true); }
  });

  test("all guards pass, preview ok: 200, Cache-Control: no-store, the exact preview body, no `ok` field leaking through", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesPreview: async (id) => ({ ok: true, keys: [`${id}-1`], total: 1, cap: 50, warning: null }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toEqual({ keys: ["triage-1"], total: 1, cap: 50, warning: null });
      expect("ok" in (body as object)).toBe(false);
    } finally { await app.stop(true); }
  });

  // FACTORY-730 (ticket item 3): the edit dialog's draft-query dry-run — a
  // `?query=` param is decoded and passed through to `deps.rulesPreview` as
  // its own `queryOverride` argument, never read off the rule's saved query.
  test("FACTORY-730: a ?query= param is passed through to rulesPreview as queryOverride", async () => {
    const guard = { port: 0 };
    let receivedOverride: string | undefined;
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesPreview: async (id, queryOverride) => {
        receivedOverride = queryOverride;
        return { ok: true, keys: [], total: 0, cap: 50, warning: null };
      },
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules/triage/preview?query=${encodeURIComponent("project = NEW")}`, { headers });
      expect(res.status).toBe(200);
      expect(receivedOverride).toBe("project = NEW");
    } finally { await app.stop(true); }
  });

  test("no ?query= param: queryOverride is undefined", async () => {
    const guard = { port: 0 };
    let receivedOverride: string | undefined = "not called";
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesPreview: async (id, queryOverride) => {
        receivedOverride = queryOverride;
        return { ok: true, keys: [], total: 0, cap: 50, warning: null };
      },
    });
    try {
      await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(receivedOverride).toBeUndefined();
    } finally { await app.stop(true); }
  });

  test("preview refusal (e.g. rate limited) maps status and error through", async () => {
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesPreview: async () => ({ ok: false, status: 429, error: "rate limited: at most one preview per rule every 2000ms" }),
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules/triage/preview`, { headers });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate limited: at most one preview per rule every 2000ms" });
    } finally { await app.stop(true); }
  });

  // PR #642 review round 2, G4: `params.id` is already percent-decoded ONCE
  // by Elysia's own router before this handler ever sees it (verified: an
  // invalid UTF-8 byte sequence like `%E0%A4%A` decodes leniently there, to
  // the Unicode replacement character, never throwing) — so the throw this
  // route must catch is on the SECOND decode this route itself performs. A
  // double-encoded escape (`%25A`, which Elysia's first pass turns into the
  // literal two characters `%A`) is what reproduces it: this route's own
  // `decodeURIComponent("%A")` throws `URIError`, which must become a 400
  // JSON error, never an uncaught 500, and `rulesPreview` must never be
  // called with garbage.
  test("a double-encoded %-escape in the rule id throws on this route's OWN decode: 400 JSON error, never a 500, rulesPreview never called", async () => {
    let previewed = false;
    const guard = { port: 0 };
    const { app, headers } = startApp({
      dashboardOriginGuard: guard,
      peerUidCheck: () => true,
      rulesPreview: async () => { previewed = true; return { ok: true, keys: [], total: 0, cap: 50, warning: null }; },
    });
    try {
      const res = await fetch(`${headers.origin}/api/rules/%25A/preview`, { headers });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "malformed rule id" });
      expect(previewed).toBe(false);
    } finally { await app.stop(true); }
  });
});
