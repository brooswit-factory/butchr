import { codexMcpServerNames, spawnArgs } from "../src/agents/argv.js";

/** Configuration parsing only: no TUI, model turn, or MCP connection. */
export function verifyCodexConfig(): void {
  const run = (args: string[]): any => {
    const result = Bun.spawnSync(["codex", ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error("Codex configuration probe failed (raw output withheld)");
    try { return JSON.parse(result.stdout.toString()); }
    catch { throw new Error("Codex returned invalid inventory JSON (raw output withheld)"); }
  };
  const disabledMcpServers = codexMcpServerNames(JSON.stringify(run(["mcp", "list", "--json"])));
  const spec = { key: "TEST-1", issuetype: "Task", summary: "configuration fixture", parent: null };
  // Remove only the initial prompt; retain the production launch flags.
  const args = spawnArgs(spec, process.cwd(), { provider: "codex", disabledMcpServers }, "http://127.0.0.1:9/mcp").slice(1);
  const servers = run([...args, "mcp", "list", "--json"]);
  if (!Array.isArray(servers) || servers.some((s) => s.name !== "butchr" && s.enabled !== false)) throw new Error("Inherited MCP server remains enabled");
  const server = run([...args, "mcp", "get", "butchr", "--json"]);
  if (server.enabled !== true || server.transport?.url !== "http://127.0.0.1:9/mcp" ||
      server.transport?.http_headers?.["x-issue"] !== "TEST-1" ||
      server.transport?.http_headers?.["x-butchr-provider"] !== "codex") throw new Error("Butchr MCP configuration mismatch");
  console.log(`Codex config verified: Butchr enabled, ${disabledMcpServers.length} inherited servers disabled; no connections or model turns.`);
}

if (import.meta.main) verifyCodexConfig();
