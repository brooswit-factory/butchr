import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildWorkspace, type SpawnSpec } from "../../src/agents/workspace.js";
import { buildApp } from "../../src/daemon/app.js";
import { listenOptions } from "../../src/daemon/listen.js";
import { startBridge } from "../../src/mcp/bridge.js";
import { callerIdentity } from "../../src/mcp/identity.js";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";

// The daemon binds 127.0.0.1 only and hands agents `http://localhost:<port>/mcp`
// (src/daemon/index.ts). On hosts where localhost resolves to ::1 first, every
// client has to fall back to IPv4. This runs the real app on the real listen
// options and drives the AGY stdio bridge through workspace metadata against
// it, with a stub read-only tool and no daemon, herd, or provider.

const view = {
  state: async () => [],
  open: async () => ({ ok: false }),
  openPane: async () => ({ ok: false }),
  health: () => ({ ok: true, components: [] }),
  dashboard: async () => ({ checked: true as const, confirmedAt: new Date(0).toISOString(), rows: [], admission: { cap: 0, residency: null, sources: [] } }),
  header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "test fixture", version: "0.0.0" } }),
  resourceLink: async (key: string) => ({ ok: true as const, url: `https://example.invalid/${key}` }),
};
const tools = {
  whoami: { description: "Echo the caller identity", input: {}, handler: (_args: unknown, connection: { headers: Record<string, string | undefined> }) => ({ caller: callerIdentity(connection.headers), provider: connection.headers["x-butchr-provider"] }) },
};

let app: ReturnType<typeof buildApp>["app"];
let mcp: ReturnType<typeof buildApp>["mcp"];
let mcpUrl: string;
beforeAll(() => {
  ({ app, mcp } = buildApp(view as never, tools as never, () => {}));
  app.listen(listenOptions(0));
  mcpUrl = `http://localhost:${app.server!.port}/mcp`;
});
afterAll(async () => { await mcp.closeAll(); await app.stop(true); });

let root: string;
const prev = process.env.BUTCHR_WORKSPACES;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "butchr-loopback-")); process.env.BUTCHR_WORKSPACES = root; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); if (prev === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = prev; });

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for bridge reply");
    await Bun.sleep(5);
  }
}

async function bridgeFor(spec: SpawnSpec) {
  const { url, identity, agent } = bridgeWorkspace(root, buildWorkspace(spec, mcpUrl, "agy"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const bridge = await startBridge(url, identity, { stdin, stdout, onError: (e) => errors.push(e), ...(agent ? { agent } : {}) });
  const request = async (method: string, id: number, params?: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    await until(() => messages.some((m) => "id" in m && m.id === id));
    return messages.find((m) => "id" in m && m.id === id)!;
  };
  return { bridge, errors, request, url, send: (m: JSONRPCMessage) => stdin.write(`${JSON.stringify(m)}\n`) };
}

describe("daemon loopback listener with the AGY MCP bridge", () => {
  const specs: Array<[string, SpawnSpec, Record<string, unknown>]> = [
    ["a jira-work agent", { key: "jira-work:task:BUTCHR-1", resource: "BUTCHR-1", issuetype: "task", summary: "s", parent: null, brief: "do it" }, { provider: "jira-work", issue: "BUTCHR-1", agent: "jira-work:task:BUTCHR-1" }],
    ["a github-issue agent", { key: "github-issue:bugs:acme%2Fw%2312", resource: "acme/w#12", issuetype: "bug", summary: "s", parent: null, brief: "fix it" }, { provider: "github-issue", agent: "github-issue:bugs:acme%2Fw%2312" }],
  ];
  for (const [name, spec, caller] of specs) {
    test(`${name} connects over localhost, lists tools, and calls one with its identity`, async () => {
      const client = await bridgeFor(spec);
      try {
        expect(client.url.hostname).toBe("localhost");
        const init = await client.request("initialize", 1, { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "loopback-test", version: "1" } });
        expect(init).toMatchObject({ result: { serverInfo: { name: "butchr" } } });
        client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        expect(await client.request("tools/list", 2)).toMatchObject({ result: { tools: [{ name: "whoami" }] } });
        const reply = JSON.stringify(await client.request("tools/call", 3, { name: "whoami", arguments: {} }));
        for (const value of Object.values(caller)) expect(reply).toContain(JSON.stringify(value).slice(1, -1));
        expect(reply).toContain("agy");
        expect(client.errors).toEqual([]);
      } finally {
        await client.bridge.close();
      }
    });
  }

  test.skipIf(!Bun.which("node"))("a Node client reaches the loopback-only listener through localhost", async () => {
    const child = Bun.spawn(["node", "-e", `fetch(${JSON.stringify(mcpUrl.replace("/mcp", "/health"))}).then((r) => process.exit(r.status === 200 ? 0 : 2), (e) => { console.error(e.cause ?? e); process.exit(1); })`], { stdout: "pipe", stderr: "pipe" });
    const code = await child.exited;
    expect({ code, stderr: await new Response(child.stderr).text() }).toEqual({ code: 0, stderr: "" });
  });
});
