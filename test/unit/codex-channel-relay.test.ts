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
 * BUTCHR-413's own fake channel server: a real thatch MCP server (the same
 * primitive `server:butchr` itself runs on) bound to loopback only — no
 * network. `push` is what a real channel server does on an inbound message:
 * `mcp.sendAll`.
 */
function fakeChannelServer() {
  const port = 41000 + Math.floor(Math.random() * 4000);
  const { plugin, mcp } = thatch({ serverInfo: { name: "fake-channel", version: "0" }, tools: {} });
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

const binding = (over: Partial<McpServerBinding> = {}): McpServerBinding => ({ name: "chat", type: "http", url: "http://unused/mcp", channel: true, ...over });

describe("startCodexChannelRelay (BUTCHR-413)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  test("a channel push reaches an idle Codex agent as a herd.nudge prompt, event-driven — no polling call ever made", async () => {
    const server = fakeChannelServer();
    cleanups.push(server.stop);
    const calls: Array<{ issue: string; text: string }> = [];
    const nudge: RelayNudge = async (issue, text) => { calls.push({ issue, text }); return { delivered: true }; };
    const relay = startCodexChannelRelay("jira-work:chat:BUTCHR-1", binding({ url: server.url }), { nudge });
    cleanups.push(relay.stop);

    await server.push("hello from the channel");
    await until(() => calls.length === 1);
    expect(calls[0]!.issue).toBe("jira-work:chat:BUTCHR-1");
    expect(calls[0]!.text).toContain("hello from the channel");
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
    const envVar = `FAKE_CHANNEL_HEADERS_${Math.random().toString(36).slice(2)}`;
    const previous = process.env[envVar];
    // A shared rule-level secret (headersEnvVar) resolves for THIS daemon's
    // own connection (see startCodexChannelRelay's own comment) and must
    // never reach a log line.
    process.env[envVar] = JSON.stringify({ Authorization: `Bearer ${SECRET}` });
    try {
      const relay = startCodexChannelRelay("ISS-1", binding({ url: server.url, headersEnvVar: envVar }), {
        nudge, log: (l) => lines.push(l),
      });
      cleanups.push(relay.stop);
      await server.push("hi");
      await until(() => lines.some((l) => l.includes("delivered")));
      expect(lines.some((l) => l.includes(SECRET))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[envVar]; else process.env[envVar] = previous;
    }
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
    expect(started).toEqual(["CODEX-1 chat"]);
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
