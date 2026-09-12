import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Elysia } from "elysia";
import { thatch } from "@brooswit/thatch";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startBridge, type BridgeOptions } from "../../src/mcp/bridge.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for bridge fixture");
    await Bun.sleep(5);
  }
}

async function connect(url: URL, identity: string, options: BridgeOptions = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let buffer = "";
  stdout.on("data", chunk => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const bridge = await startBridge(url, identity, {
    stdin, stdout, onError: error => errors.push(error), ...options,
  });
  const send = (message: JSONRPCMessage) => stdin.write(`${JSON.stringify(message)}\n`);
  const request = async (method: string, id: string | number, params?: Record<string, unknown>) => {
    send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    await until(() => messages.some(message => "id" in message && message.id === id));
    return messages.find(message => "id" in message && message.id === id)!;
  };
  const initialize = async () => {
    const result = await request("initialize", 1, {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  };
  return { ...bridge, stdin, stdout, messages, errors, send, request, initialize };
}

describe("MCP stdio bridge", () => {
  test("import is inert and does not attach stdin or process handlers", async () => {
    const script = `
      const events = ['data', 'end', 'error', 'close'];
      const before = events.map(e => process.stdin.listenerCount(e));
      const signals = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
      await import('./src/mcp/bridge.ts');
      if (JSON.stringify(before) !== JSON.stringify(events.map(e => process.stdin.listenerCount(e)))) process.exit(1);
      if (signals !== process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')) process.exit(2);
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: new URL("../../", import.meta.url).pathname, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    } finally { child.kill(); }
  });

  test("Thatch 0.6.3 stub isolates two identities and owns initialization and tools", async () => {
    const requests: { method: string; issue: string | null; provider: string | null; session: string | null }[] = [];
    const { plugin, mcp } = thatch({
      serverInfo: { name: "local-stub", version: "1" },
      tools: {
        identity: {
          description: "Return this local test session's headers", input: {},
          handler: (_args, connection) => ({ issue: connection.headers["x-issue"], provider: connection.headers["x-butchr-provider"] }),
        },
      },
    });
    const app = new Elysia().onRequest(({ request }) => {
      requests.push({ method: request.method, issue: request.headers.get("x-issue"), provider: request.headers.get("x-butchr-provider"), session: request.headers.get("mcp-session-id") });
    }).use(plugin).listen({ hostname: "127.0.0.1", port: 0 });
    const url = new URL(`http://127.0.0.1:${app.server!.port}/mcp`);
    const a = await connect(url, "TEST-1");
    const b = await connect(url, "TEST-2");
    try {
      a.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      expect(await a.request("server/discover", "probe")).toEqual({ jsonrpc: "2.0", id: "probe", error: { code: -32601, message: "Method not found" } });
      expect(requests).toEqual([]);
      for (const client of [a, b]) {
        expect(await client.initialize()).toMatchObject({ result: { serverInfo: { name: "local-stub", version: "1" } } });
        expect(await client.request("tools/list", 2)).toMatchObject({ result: { tools: [{ name: "identity" }] } });
      }
      for (const [client, issue] of [[a, "TEST-1"], [b, "TEST-2"]] as const) {
        const response = await client.request("tools/call", 3, { name: "identity", arguments: {} });
        expect(JSON.stringify(response)).toContain(issue);
        expect(JSON.stringify(response)).toContain("agy");
        expect(JSON.stringify(response)).not.toContain(issue === "TEST-1" ? "TEST-2" : "TEST-1");
      }
      const connections = mcp.connections.list();
      expect(connections).toHaveLength(2);
      expect(new Set(connections.map(c => c.id)).size).toBe(2);
      a.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      await a.request("ping", 4);
      await a.close();
      await until(() => mcp.connections.count() === 1);
      expect(await b.request("tools/call", 4, { name: "identity" })).toHaveProperty("result");
      await b.close();
      expect(requests.some(r => r.method === "GET")).toBe(true);
      expect(requests.filter(r => r.method === "DELETE")).toHaveLength(2);
      for (const request of requests) {
        expect(request.provider).toBe("agy");
        expect(["TEST-1", "TEST-2"]).toContain(request.issue ?? "");
        if (request.session) expect(connections.find(c => c.id === request.session)?.headers["x-issue"]).toBe(request.issue ?? "");
      }
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await mcp.closeAll();
      await app.stop(true);
    }
  });

  test("relays SSE replies and ordinary notifications, drops Claude channel frames, and tracks only initialize protocol", async () => {
    const versions: (string | null)[] = [];
    const methods: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
      const message = JSONRPCMessageSchema.parse(await request.json());
      if (!("method" in message)) return new Response(null, { status: 202 });
      methods.push(message.method);
      versions.push(request.headers.get("mcp-protocol-version"));
      if (message.method === "initialize" && "id" in message) return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub", version: "1" } } }, { headers: { "mcp-session-id": "local" } });
      if (!("id" in message)) return new Response(null, { status: 202 });
      const frames = [
        { jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "private", meta: {} } },
        { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "not-initialize", content: [] } },
      ];
      return new Response(frames.map(frame => `event: message\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const client = await connect(new URL(`http://127.0.0.1:${server.port}/mcp`), "TEST-1");
    try {
      await client.initialize();
      await client.request("tools/call", 2, { name: "unknown-but-forwarded" });
      client.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      await client.request("tools/list", 3);
      expect(methods).toContain("notifications/roots/list_changed");
      expect(versions.slice(1).every(version => version === "2025-03-26")).toBe(true);
      expect(client.messages.filter(m => "method" in m).map(m => m.method)).toEqual(["notifications/tools/list_changed", "notifications/tools/list_changed"]);
      expect(client.errors).toEqual([]);
    } finally { await client.close(); await server.stop(true); }
  });

  test.each(["eof", "http-error", "timeout", "framing", "output-error"])("bounded cleanup on %s, including a hung DELETE", async mode => {
    let deletes = 0;
    const pending: (() => void)[] = [];
    const hang = () => new Promise<Response>(resolve => pending.push(() => resolve(new Response(null, { status: 204 }))));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method === "DELETE") { deletes++; return hang(); }
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = JSONRPCMessageSchema.parse(await request.json());
      if (!("method" in message)) return new Response(null, { status: 202 });
      if (message.method === "initialize" && "id" in message) return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub", version: "1" } } }, { headers: { "mcp-session-id": "local" } });
      if (!("id" in message)) return new Response(null, { status: 202 });
      if (mode === "timeout") return hang();
      return new Response("sensitive upstream details", { status: 503 });
    } });
    const client = await connect(new URL(`http://127.0.0.1:${server.port}/mcp`), "TEST-1", { requestTimeoutMs: 100, cleanupTimeoutMs: 40 });
    try {
      await client.initialize();
      const started = Date.now();
      if (mode === "eof") client.stdin.end();
      else if (mode === "framing") client.stdin.write("invalid json\n");
      else if (mode === "output-error") client.stdout.emit("error", new Error("broken pipe"));
      else client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      let done = false;
      void client.closed.then(() => { done = true; });
      await until(() => done);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(deletes).toBe(1);
      expect(client.errors).toHaveLength(mode === "eof" ? 0 : 1);
      expect(JSON.stringify(client.errors)).not.toContain("sensitive");
      expect(client.stdin.listenerCount("data")).toBe(0);
      expect(client.stdin.listenerCount("end")).toBe(0);
      expect(client.stdin.listenerCount("error")).toBe(0);
      expect(client.stdout.listenerCount("error")).toBe(0);
      expect(client.close()).toBe(client.close());
    } finally {
      await client.close();
      for (const release of pending) release();
      await server.stop(true);
    }
  });

  test("rejects invalid arguments before taking ownership of streams", async () => {
    for (const identity of ["", " ", "TEST-1\r\nx-other: injected", " TEST-1"]) {
      await expect(startBridge(new URL("http://127.0.0.1:1/mcp"), identity)).rejects.toThrow("identity");
    }
    await expect(startBridge(new URL("file:///tmp/mcp"), "TEST-1")).rejects.toThrow("HTTP URL");
    await expect(startBridge(new URL("http://127.0.0.1:1/mcp"), "TEST-1", { cleanupTimeoutMs: Infinity })).rejects.toThrow("timeouts");
  });
});
