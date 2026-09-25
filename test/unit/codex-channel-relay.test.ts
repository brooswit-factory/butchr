import { describe, expect, test, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { thatch } from "@brooswit/thatch";
import { listenOptions } from "../../src/daemon/listen.js";
import {
  startCodexChannelRelay, createCodexChannelRelayPool,
  type CodexChannelRelayHandle, type CodexChannelRelayPool, type RelayNudge,
} from "../../src/notify/codex-channel-relay.js";
import type { McpServerBinding } from "../../src/rules/rules.js";

/**
 * BUTCHR-413's own "fake Rocket.Chat" harness: a real thatch MCP server (the
 * same primitive `rocketr` would be, and the same one `server:butchr` itself
 * runs on) bound to loopback only — no network, no live RC. `push` is what a
 * real rocketr would do on an inbound RC channel message or DM: `mcp.sendAll`.
 */
function fakeChannelServer() {
  const port = 41000 + Math.floor(Math.random() * 4000);
  const { plugin, mcp } = thatch({ serverInfo: { name: "fake-rocketr", version: "0" }, tools: {} });
  const app = new Elysia().use(plugin);
  app.listen(listenOptions(port));
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    // `startCodexChannelRelay`'s own MCP client connects in the background
    // (its constructor doesn't await readiness), so a push issued the
    // instant a relay is created can race ahead of that connection — thatch's
    // `sendAll` only reaches CURRENTLY connected clients, it never queues for
    // a later one. Retrying until at least one client is connected is the
    // realistic stand-in for "a channel server pushes once the agent's
    // relay is actually subscribed" without an arbitrary fixed sleep.
    async push(content: string, meta: Record<string, string> = {}) {
      const deadline = Date.now() + 3000;
      for (;;) {
        const result = await mcp.sendAll({ content, meta });
        if (result.sent.length > 0) return result;
        if (Date.now() > deadline) throw new Error("fakeChannelServer: no relay ever connected to receive this push");
        await Bun.sleep(20);
      }
    },
    async stop() { await mcp.closeAll(); app.stop(); },
  };
}

async function until(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

const binding = (over: Partial<McpServerBinding> = {}): McpServerBinding => ({ name: "rocketr", type: "http", url: "http://unused/mcp", channel: true, ...over });

describe("startCodexChannelRelay (BUTCHR-413)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  test("an RC channel push reaches an idle Codex agent as a herd.nudge prompt, event-driven — no polling call ever made", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const calls: Array<{ issue: string; text: string }> = [];
    const nudge: RelayNudge = async (issue, text) => { calls.push({ issue, text }); return { delivered: true }; };
    const relay = startCodexChannelRelay("jira-work:rc:BUTCHR-1", binding({ url: server.url }), { nudge });
    cleanups.push(relay.stop);

    await server.push("hello from rocketr");
    await until(() => calls.length === 1);
    expect(calls[0]!.issue).toBe("jira-work:rc:BUTCHR-1");
    expect(calls[0]!.text).toContain("hello from rocketr");
  });

  test("no duplicate delivery: the same message id pushed twice nudges once", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const calls: string[] = [];
    const nudge: RelayNudge = async (issue) => { calls.push(issue); return { delivered: true }; };
    const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url }), { nudge });
    cleanups.push(relay.stop);

    await server.push("first delivery", { id: "msg-1" });
    await until(() => calls.length === 1);
    await server.push("first delivery", { id: "msg-1" }); // e.g. a reconnect replay
    await Bun.sleep(150);
    expect(calls.length).toBe(1);
  });

  test("distinct messages are never coalesced by dedup (different ids, same text)", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const calls: string[] = [];
    const nudge: RelayNudge = async (issue) => { calls.push(issue); return { delivered: true }; };
    const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url }), { nudge });
    cleanups.push(relay.stop);

    await server.push("same text", { id: "a" });
    await server.push("same text", { id: "b" });
    await until(() => calls.length === 2);
    expect(calls.length).toBe(2);
  });

  test("messages are delivered one at a time — a slow nudge is never double-invoked while it is still in flight", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    let inFlight = 0;
    let maxConcurrent = 0;
    const done: string[] = [];
    const nudge: RelayNudge = async (issue) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Bun.sleep(50);
      inFlight--; done.push(issue);
      return { delivered: true };
    };
    const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url }), { nudge });
    cleanups.push(relay.stop);

    await server.push("one", { id: "1" });
    await server.push("two", { id: "2" });
    await until(() => done.length === 2, 5000);
    expect(maxConcurrent).toBe(1);
  });

  test("a refused/absent nudge (delivered:false) is retried rather than dropped", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    let attempts = 0;
    const nudge: RelayNudge = async () => { attempts++; return { delivered: attempts >= 3 }; };
    const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url }), { nudge, dedupWindowMs: 60_000 });
    cleanups.push(relay.stop);

    // InboxRelay's default retryMs is 5s; inject a fast clock isn't available
    // here (retryMs isn't exposed by this module), so just prove eventual
    // delivery rather than timing it precisely.
    await server.push("retry me", { id: "r1" });
    await until(() => attempts >= 3, 20_000);
  }, 25_000);

  test("no header value ever appears in a log line", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const lines: string[] = [];
    const nudge: RelayNudge = async () => ({ delivered: true });
    const SECRET = "sekrit-bearer-token-xyz";
    const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url, headersEnvVar: "FAKE_ROCKETR_HEADERS" }), {
      nudge, log: (l) => lines.push(l), identityFor: () => ({ url: server.url, userId: "u1", authToken: SECRET, username: "codex-1" }),
    });
    cleanups.push(relay.stop);
    await server.push("hi");
    await until(() => lines.some((l) => l.includes("delivered")));
    expect(lines.some((l) => l.includes(SECRET))).toBe(false);
  });

  test("review finding 2: per-agent identity — two Codex agents bound to the SAME binding get distinct connection identities, so a message addressed to one reaches only it", async () => {
    const port = 41000 + Math.floor(Math.random() * 4000);
    const { plugin, mcp } = thatch({ serverInfo: { name: "fake-rocketr", version: "0" }, tools: {} });
    const app = new Elysia().use(plugin);
    app.listen(listenOptions(port));
    const url = `http://127.0.0.1:${port}/mcp`;
    cleanups.push(async () => { await mcp.closeAll(); app.stop(); });

    const callsA: string[] = [];
    const callsB: string[] = [];
    const nudgeA: RelayNudge = async (issue) => { callsA.push(issue); return { delivered: true }; };
    const nudgeB: RelayNudge = async (issue) => { callsB.push(issue); return { delivered: true }; };
    const relayA = startCodexChannelRelay("AGENT-A", binding({ url }), { nudge: nudgeA, identityFor: () => ({ url, userId: "user-a", authToken: "token-a", username: "codex-a" }) });
    const relayB = startCodexChannelRelay("AGENT-B", binding({ url }), { nudge: nudgeB, identityFor: () => ({ url, userId: "user-b", authToken: "token-b", username: "codex-b" }) });
    cleanups.push(relayA.stop, relayB.stop);

    // Stands in for rocketr routing a DM by the connection's own identity —
    // exactly the pattern src/daemon/app.ts's own `notifyAgent` already uses
    // (`sendAll(..., { where: (c) => c.headers[...] === target })`).
    const pushToUser = async (userId: string, content: string, meta: Record<string, string> = {}) => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const result = await mcp.sendAll({ content, meta }, { where: (c: { headers: Record<string, string> }) => c.headers["x-user-id"] === userId });
        if (result.sent.length > 0) return result;
        if (Date.now() > deadline) throw new Error("no matching connection ever connected");
        await Bun.sleep(20);
      }
    };

    await pushToUser("user-a", "DM for A", { id: "dm-1" });
    await until(() => callsA.length === 1);
    await Bun.sleep(150);
    expect(callsA).toEqual(["AGENT-A"]);
    expect(callsB).toEqual([]);
  });
});

describe("createCodexChannelRelayPool (BUTCHR-413)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  test("starts a relay only for a running Codex agent whose rule has a channel:true binding", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const started: string[] = [];
    const fakeStart = (issue: string, b: McpServerBinding): CodexChannelRelayHandle => { started.push(`${issue} ${b.name}`); return { stop: async () => {} }; };
    const pool = createCodexChannelRelayPool({
      nudge: async () => ({ delivered: true }),
      runningIssues: async () => ["CODEX-1", "CLAUDE-1", "CODEX-NO-BINDING"],
      bindingsOf: (issue) => issue === "CODEX-1" ? [binding()] : issue === "CODEX-NO-BINDING" ? [binding({ channel: false })] : undefined,
      providerOf: async (issue) => issue === "CODEX-1" || issue === "CODEX-NO-BINDING" ? "codex" : "claude",
      start: fakeStart,
    });
    cleanups.push(pool.stopAll);
    await pool.reconcile();
    expect(started).toEqual(["CODEX-1 rocketr"]);
    expect(pool.size).toBe(1);
  });

  test("stops a relay once its issue is no longer running", async () => {
    const stopped: string[] = [];
    let running = ["CODEX-1"];
    const pool = createCodexChannelRelayPool({
      nudge: async () => ({ delivered: true }),
      runningIssues: async () => running,
      bindingsOf: () => [binding()],
      providerOf: async () => "codex",
      start: (issue) => ({ stop: async () => { stopped.push(issue); } }),
    });
    await pool.reconcile();
    expect(pool.size).toBe(1);
    running = [];
    await pool.reconcile();
    expect(pool.size).toBe(0);
    expect(stopped).toEqual(["CODEX-1"]);
  });

  test("stops a relay once its agent falls back off Codex (ordered provider fallback) even though the issue is still running", async () => {
    const stopped: string[] = [];
    let provider: "codex" | "claude" = "codex";
    const pool = createCodexChannelRelayPool({
      nudge: async () => ({ delivered: true }),
      runningIssues: async () => ["ISS-1"],
      bindingsOf: () => [binding()],
      providerOf: async () => provider,
      start: (issue) => ({ stop: async () => { stopped.push(issue); } }),
    });
    await pool.reconcile();
    expect(pool.size).toBe(1);
    provider = "claude"; // e.g. Codex quota-refused, fallback moved this issue to Claude
    await pool.reconcile();
    expect(pool.size).toBe(0);
    expect(stopped).toEqual(["ISS-1"]);
  });

  test("review finding 3: a transient 'unknown provider' (null) never tears down an existing relay — only a running issue's OBSERVED non-codex provider or a stopped issue does", async () => {
    const stopped: string[] = [];
    const started: string[] = [];
    let provider: "codex" | null = "codex";
    const pool = createCodexChannelRelayPool({
      nudge: async () => ({ delivered: true }),
      runningIssues: async () => ["ISS-1"],
      bindingsOf: () => [binding()],
      providerOf: async () => provider,
      start: (issue) => { started.push(issue); return { stop: async () => { stopped.push(issue); } }; },
    });
    await pool.reconcile();
    expect(pool.size).toBe(1);
    expect(started).toEqual(["ISS-1"]);

    provider = null; // herdr hiccup / starting shell / pane blocked on a dialog — NOT "not codex"
    await pool.reconcile();
    await pool.reconcile(); // several polls in a row while still unresolved
    expect(pool.size).toBe(1);
    expect(stopped).toEqual([]); // never torn down
    expect(started).toEqual(["ISS-1"]); // and never rebuilt either — same handle throughout
  });

  test("review finding 3, end to end: an existing relay survives a poll where providerOf returns null and still delivers the next push", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const calls: string[] = [];
    let provider: "codex" | null = "codex";
    const pool = createCodexChannelRelayPool({
      nudge: async (issue) => { calls.push(issue); return { delivered: true }; },
      runningIssues: async () => ["ISS-1"],
      bindingsOf: () => [binding({ url: server.url })],
      providerOf: async () => provider,
    });
    cleanups.push(pool.stopAll);
    await pool.reconcile();
    provider = null;
    await pool.reconcile(); // must NOT close the connection this relay already made

    await server.push("still alive?", { id: "after-null" });
    await until(() => calls.length === 1);
    expect(calls).toEqual(["ISS-1"]);
  });

  test("never asks providerOf for an issue with no channel binding at all (Claude's own fleet is untouched)", async () => {
    const providerLookups: string[] = [];
    const pool = createCodexChannelRelayPool({
      nudge: async () => ({ delivered: true }),
      runningIssues: async () => ["NO-BINDING"],
      bindingsOf: () => undefined,
      providerOf: async (issue) => { providerLookups.push(issue); return "codex"; },
      start: () => ({ stop: async () => {} }),
    });
    await pool.reconcile();
    expect(providerLookups).toEqual([]);
    expect(pool.size).toBe(0);
  });

  test("the seam is real: a hand-written alternate CodexChannelRelayPool implementation drives the same caller unchanged", async () => {
    // Stands in for what BUTCHR-359 replaces this whole module with — the
    // caller (this tiny function, mirroring src/daemon/index.ts's own
    // wiring) only ever depends on the CodexChannelRelayPool interface.
    async function wireIntoDaemonTick(pool: CodexChannelRelayPool) { await pool.reconcile(); }
    let reconciled = 0;
    const alternate: CodexChannelRelayPool = {
      async reconcile() { reconciled++; },
      async stopAll() {},
      size: 0,
    };
    await wireIntoDaemonTick(alternate);
    expect(reconciled).toBe(1);
  });
});
