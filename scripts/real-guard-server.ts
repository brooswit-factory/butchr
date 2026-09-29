/**
 * FACTORY-478/FACTORY-480: a minimal, REAL HTTP server for the real-browser
 * regression test that lives in the `clevr` repo (see that repo's
 * `scripts/real-daemon-origin-test.mjs`) — every route and every guard
 * function this file wires up is the ACTUAL production code
 * (`src/daemon/app.ts`'s `buildApp`, `src/web/view.ts`'s `liveView`,
 * `src/web/origin-guard.ts`'s `checkExtensionOrigin`/
 * `preflightExtensionOrigin`), unmodified. Nothing here reimplements the
 * guard.
 *
 * What is NOT real: everything `buildApp`/`liveView` needs besides the
 * guarded routes (a live Jira/GitHub-fed dashboard poll, a real herdr pane
 * registry, a real MCP tool surface) — spinning up the FULL daemon requires
 * live Atlassian credentials and a running herdr fleet, neither of which
 * belongs in a regression test for an HTTP header. Those `ViewDeps` are
 * stubbed to trivial, honest values below (an always-empty dashboard: no
 * resource this daemon tracks will ever match, which is a normal response
 * shape, never an error — see docs/resources-for-url.md). This is the SAME
 * "call the real route/guard code directly with stub surrounding deps"
 * technique `test/unit/resources-for-url-route.test.ts` already uses — this
 * script only takes that from an in-process `app.handle()` call to a real,
 * listening Bun HTTP server a real headless-Chrome extension can actually
 * connect to.
 *
 * Env:
 *   REAL_GUARD_PORT             — port to listen on (127.0.0.1 only, same as the real daemon — src/daemon/listen.ts)
 *   REAL_GUARD_ALLOWED_ORIGINS  — comma-separated chrome-extension://<id> origins (may be empty/absent — same "empty means disabled" default `liveView` itself uses)
 *
 * Prints exactly one line, `REAL_GUARD_READY <port>`, once listening — the
 * driving test greps stdout for it the same way
 * `clevr/scripts/smoke-test.mjs` already greps `fake-pty-server.mjs`'s own
 * `FAKE_PTY_PORT=<port>` line.
 */
import { buildApp } from "../src/daemon/app.js";
import { DAEMON_HOSTNAME } from "../src/daemon/listen.js";
import type { ViewDeps } from "../src/web/view.js";
import { buildResourcesForUrlResponse } from "../src/resources/resource-lookup.js";
import type { OriginGuardDeps } from "../src/web/origin-guard.js";

const port = Number(process.env.REAL_GUARD_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("REAL_GUARD_PORT must be set to a positive integer");
  process.exit(1);
}

const allowedOrigins = (process.env.REAL_GUARD_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const extensionAuth: OriginGuardDeps = { allowedOrigins };

const notImplemented = (name: string) => async () => {
  throw new Error(`real-guard-server.ts: ${name} is not implemented — this route is out of scope for the Origin-guard regression test`);
};

// No agents staffed, no rows — an empty-but-real dashboard snapshot, so
// `buildResourcesForUrlResponse` (unmodified production code) always
// resolves to `{ resource: null, agents: [] }` for any URL, which is a
// perfectly normal, honest response shape (see docs/resources-for-url.md)
// and is enough to prove the GUARD's behavior, which is this test's whole
// point — not the resource-matching logic, which the unit tests under
// test/unit already cover.
const view: ViewDeps = {
  state: async () => [],
  open: notImplemented("open"),
  openPane: notImplemented("openPane"),
  health: () => ({ ok: true, components: [] }),
  dashboard: async () => ({ checked: true, confirmedAt: new Date().toISOString(), rows: [], admission: { cap: 0, residency: 0, sentinels: 0, sources: [] } }),
  header: () => ({ build: null }),
  resourceLink: notImplemented("resourceLink"),
  configInventory: async () => ({ rules: [], sessionDefinitions: [], errors: [] }),
  resourcesForUrl: (url) => Promise.resolve(buildResourcesForUrlResponse(url, { jiraHost: "example.atlassian.net" }, [])),
  extensionAuth,
  // ptyAttach deliberately omitted: `/agents/:agentKey/pty` is reachable
  // through the SAME `extensionAuth` guard as `/resources/for-url` (see
  // src/web/origin-guard.ts's own header for why one guard covers both),
  // and this script's whole purpose is observing that guard's behavior on a
  // WebSocket upgrade from a real browser — not standing up a real pane.
  // With `ptyAttach` absent, a request that clears the guard gets a 503
  // ("endpoint disabled"); one the guard itself rejects gets 403 first,
  // `beforeHandle` never reaching the `!deps.ptyAttach` check at all. That
  // difference (403 with `{error:"origin required"}` vs. anything else) is
  // exactly the signal the driving test reads to answer "did this WebSocket
  // upgrade carry Origin".
};

const { app } = buildApp(view);

// TEST-ONLY instrumentation, never shipped: records every request this
// process sees for the WebSocket-upgrade route, specifically so the driving
// browser test (clevr's scripts/real-daemon-origin-test.mjs) can answer
// DoD #2 ("record whether Origin is present on the PTY WebSocket upgrade")
// — a browser's WebSocket API exposes no HTTP status/headers on a failed
// upgrade, so the server side has to be the one keeping the record.
// `onRequest` observes every request but changes nothing about how
// `liveView`'s own real guard handles it.
const wsLog: { path: string; origin: string | null; at: string }[] = [];
app
  .onRequest(({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/agents/") && pathname.endsWith("/pty")) {
      wsLog.push({ path: pathname, origin: request.headers.get("origin"), at: new Date().toISOString() });
    }
  })
  .get("/__test__/ws-log", () => wsLog);

app.listen({ port, hostname: DAEMON_HOSTNAME });
console.log(`REAL_GUARD_READY ${port}`);
