import { afterAll, describe, expect, test } from "bun:test";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../../src/web/view.js";
import { buildApp } from "../../src/daemon/app.js";
import { listenOptions } from "../../src/daemon/listen.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { PTY_CLOSED_REASON } from "../../src/terminal/pty-bridge.js";
import { resolvePtyPane } from "../../src/terminal/pty-attach.js";
import { createOriginGuardLogger } from "../../src/web/origin-guard-log.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const AGENT_KEY = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" });

/** The minimum `ViewDeps` this route's own handler ever touches. */
function baseDeps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const unused = () => { throw new Error("unused in this test"); };
  return {
    state: unused, open: unused, openPane: unused, health: unused, dashboard: unused,
    header: unused, resourceLink: unused, configInventory: unused,
    ...overrides,
  } as ViewDeps;
}

const AUTH = { allowedOrigins: [ORIGIN] };

function liveResolveDeps(pane = "pane-1") {
  return {
    resolve: (agentKey: string) => (agentKey === AGENT_KEY ? { ok: true as const, pane } : { ok: false as const, refusal: { reason: "unknown-pane" as const, agentKey } }),
    isLive: () => true,
    read: async () => "",
    send: async () => {},
    pollMs: 10_000,
  };
}

describe("GET /agents/:agentKey/pty — upgrade refusals (HTTP-level, before any socket opens)", () => {
  test("extensionAuth omitted (empty allowlist): 403, never reaches ptyAttach", async () => {
    const app = liveView(fakeMcp, baseDeps({ ptyAttach: liveResolveDeps() }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(res.status).toBe(403);
  });
  test("ptyAttach deps omitted (but extensionAuth set and Origin allowlisted): 503, disabled entirely", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe("endpoint disabled: not configured");
  });
  test("MISSING Origin: 403 — the only credential left, so absent means refused", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, ptyAttach: liveResolveDeps() }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket" } }));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("origin required");
  });
  test("non-allowlisted Origin: 403", async () => {
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, ptyAttach: liveResolveDeps() }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: OTHER_ORIGIN } }));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("origin not allowed");
  });
  test("malformed agent key: refused (404), Origin otherwise allowlisted", async () => {
    // Uses the REAL `resolvePtyPane` (via `resolveDeps` below), not the
    // always-"unknown-pane" fake `liveResolveDeps` above — a fake that never
    // decodes anything would trivially "pass" this test for the wrong
    // reason.
    const resolveDeps = { ...liveResolveDeps(), resolve: (agentKey: string) => resolvePtyPane(agentKey, []) };
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, ptyAttach: resolveDeps }));
    const res = await app.handle(new Request(`http://local/agents/not-a-real-key/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("not a valid agent key");
  });
  test("well-formed but unknown/not-live agent key: refused with the reused refusal wording", async () => {
    const app = liveView(fakeMcp, baseDeps({
      extensionAuth: AUTH,
      ptyAttach: { ...liveResolveDeps(), resolve: (agentKey) => ({ ok: false, refusal: { reason: "unknown-pane", agentKey } }) },
    }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(`no such live pane: ${AGENT_KEY} (not one of this daemon's own running agents)`);
  });
});

describe("FACTORY-476: guard rejections on the PTY upgrade path are logged", () => {
  test("MISSING Origin: one line, path without the agentKey's own query/fragment noise, result 'origin required'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, ptyAttach: liveResolveDeps(), originGuardLog }));
    await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket" } }));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("method=GET");
    expect(lines[0]).toContain(`path=/agents/${encodeURIComponent(AGENT_KEY)}/pty`);
    expect(lines[0]).toContain("origin=absent");
    expect(lines[0]).toContain("result=origin required");
  });
  test("non-allowlisted Origin: one line, result 'origin not allowed'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, ptyAttach: liveResolveDeps(), originGuardLog }));
    await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: OTHER_ORIGIN } }));
    expect(lines).toEqual([expect.stringContaining("result=origin not allowed")]);
  });
  test("extensionAuth omitted (empty allowlist): result 'allowlist empty'", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ ptyAttach: liveResolveDeps(), originGuardLog }));
    await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(lines).toEqual([expect.stringContaining("result=allowlist empty")]);
  });
  test("a resolve failure (unknown pane, ptyAttach disabled) past the origin guard logs nothing — out of this ticket's scope", async () => {
    const lines: string[] = [];
    const originGuardLog = createOriginGuardLogger({ now: () => 0, log: (l) => lines.push(l) });
    const app = liveView(fakeMcp, baseDeps({ extensionAuth: AUTH, originGuardLog }));
    const res = await app.handle(new Request(`http://local/agents/${encodeURIComponent(AGENT_KEY)}/pty`, { headers: { upgrade: "websocket", origin: ORIGIN } }));
    expect(res.status).toBe(503);
    expect(lines).toEqual([]);
  });
});

describe("GET /agents/:agentKey/pty — a real upgraded socket", () => {
  let paneText = "";
  let live = true;
  let readShouldThrow = false;
  const sentToPane: string[] = [];
  const view = baseDeps({
    extensionAuth: AUTH,
    ptyAttach: {
      resolve: (agentKey) => (agentKey === AGENT_KEY && live ? { ok: true as const, pane: "pane-1" } : { ok: false as const, refusal: { reason: "unknown-pane" as const, agentKey } }),
      isLive: () => live,
      read: async () => {
        if (readShouldThrow) throw new Error("herdr.pane.read failed");
        return paneText;
      },
      send: async (_pane, text) => { sentToPane.push(text); },
      pollMs: 15,
    },
  });
  const { app, mcp } = buildApp(view);
  app.listen(listenOptions(0));
  const wsUrl = `ws://localhost:${app.server!.port}/agents/${encodeURIComponent(AGENT_KEY)}/pty`;
  // A SERVER-initiated `ws.close()` (used below by the "pane disappearing"
  // test, and by this route generally whenever a pane goes away) leaves
  // `Elysia`/Bun's `app.stop(true)` hanging indefinitely afterward — measured
  // directly against a bare `new Elysia().ws(...)` route with none of this
  // ticket's own code involved, so this is an upstream quirk in the
  // WebSocket/server-stop interaction, not a bug in the route under test
  // (`ws.close()` from the CLIENT side, used by every other test in this
  // block, does not hit it). Racing the stop against a short timeout avoids
  // failing THIS test suite's own teardown on that unrelated quirk.
  afterAll(async () => {
    await mcp.closeAll();
    await Promise.race([app.stop(true), new Promise((r) => setTimeout(r, 200))]);
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { origin: ORIGIN } } as never);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }

  function nextMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve) => ws.addEventListener("message", (e) => resolve(e.data as string), { once: true }));
  }

  function nextClose(ws: WebSocket): Promise<CloseEvent> {
    return new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e as CloseEvent), { once: true }));
  }

  test("successful attach + output round-trip: new pane text arrives as a message", async () => {
    paneText = "";
    live = true;
    const ws = await connect();
    paneText = "hello from the pane";
    const msg = await nextMessage(ws);
    expect(msg).toBe("hello from the pane");
    ws.close();
    await nextClose(ws);
  });

  // FACTORY-337's ANSI FIDELITY requirement (added after epic review):
  // "bytes arrived" is not evidence a terminal will work — a
  // cursor-positioning/color escape sequence must survive the round trip
  // end to end, over the REAL socket, not just through the pure `ptyTick`
  // function (covered separately in pty-bridge.test.ts).
  test("an ANSI cursor-positioning + color escape sequence survives the real socket round trip byte-for-byte", async () => {
    paneText = "";
    live = true;
    const ws = await connect();
    const withAnsi = "\x1b[2J\x1b[1;1H\x1b[31mred\x1b[0m normal \x1b[32mgreen\x1b[0m";
    paneText = withAnsi;
    const msg = await nextMessage(ws);
    expect(msg).toBe(withAnsi);
    ws.close();
    await nextClose(ws);
  });

  test("input round-trip: a TEXT frame from the client is forwarded to the pane verbatim", async () => {
    paneText = "";
    live = true;
    sentToPane.length = 0;
    const ws = await connect();
    ws.send("echo hi\n");
    // Give the message handler a tick to run (it forwards via deps.send, no ack frame is sent back).
    await new Promise((r) => setTimeout(r, 50));
    expect(sentToPane).toContain("echo hi\n");
    ws.close();
    await nextClose(ws);
  });

  test("a resize control frame (BINARY JSON) does not close the connection, and output still flows afterward", async () => {
    paneText = "";
    live = true;
    const ws = await connect();
    const resize = new TextEncoder().encode(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws.send(resize);
    paneText = "still alive after resize";
    const msg = await nextMessage(ws);
    expect(msg).toBe("still alive after resize");
    ws.close();
    await nextClose(ws);
  });

  test("pane disappearing closes the socket with the distinguishable close reason", async () => {
    paneText = "";
    live = true;
    const ws = await connect();
    live = false;
    const closeEvent = await nextClose(ws);
    expect(closeEvent.code).toBe(4000);
    expect(closeEvent.reason).toBe(PTY_CLOSED_REASON);
  });

  test("a herdr.pane.read failure mid-session is treated the same as the pane going away", async () => {
    paneText = "";
    live = true;
    const ws = await connect();
    readShouldThrow = true;
    const closeEvent = await nextClose(ws);
    expect(closeEvent.code).toBe(4000);
    expect(closeEvent.reason).toBe(PTY_CLOSED_REASON);
    readShouldThrow = false;
  });
});

// A separate app/socket: `resolve` here returns `ok` on its FIRST call
// (consulted by `beforeHandle`, which lets the upgrade through) and `ok:
// false` on every call after — simulating the pane disappearing in the
// narrow window between `beforeHandle` approving the upgrade and `open`
// re-resolving it. `open` is expected to refuse the same way, closing the
// socket rather than starting a session over a pane it can no longer find.
describe("GET /agents/:agentKey/pty — the pane disappears between beforeHandle and open", () => {
  test("open() refuses (closes) when its own re-resolve no longer succeeds", async () => {
    let calls = 0;
    const view = baseDeps({
      extensionAuth: AUTH,
      ptyAttach: {
        resolve: (agentKey) => {
          calls += 1;
          return calls === 1 ? { ok: true as const, pane: "pane-1" } : { ok: false as const, refusal: { reason: "unknown-pane" as const, agentKey } };
        },
        isLive: () => true,
        read: async () => "",
        send: async () => {},
        pollMs: 10_000,
      },
    });
    const { app, mcp } = buildApp(view);
    app.listen(listenOptions(0));
    const wsUrl = `ws://localhost:${app.server!.port}/agents/${encodeURIComponent(AGENT_KEY)}/pty`;
    const ws = new WebSocket(wsUrl, { headers: { origin: ORIGIN } } as never);
    const closeEvent = await new Promise<CloseEvent>((resolve) => ws.addEventListener("close", (e) => resolve(e as CloseEvent), { once: true }));
    expect(closeEvent.code).toBe(4004);
    await mcp.closeAll();
    await Promise.race([app.stop(true), new Promise((r) => setTimeout(r, 200))]);
  });
});
