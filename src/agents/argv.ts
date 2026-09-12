import { effortFor, modelFor, type SpawnSpec } from "./workspace.js";

/** Claude Code's initial prompt, queued at startup and submitted once the startup dialogs are answered. */
export const KICKOFF_PROMPT = "follow your CLAUDE.md";
export type AgentProvider = "claude" | "codex";
export interface AgentConfig { provider: AgentProvider; model?: string; disabledMcpServers?: Array<{ name: string; transport: "stdio" | "streamable_http" }> }
/** Read-only inventory: never log its raw output, which can contain credentials. */
export function codexMcpServerNames(output: string): NonNullable<AgentConfig["disabledMcpServers"]> {
  const servers: unknown = JSON.parse(output);
  if (!Array.isArray(servers) || servers.some((s) => !s || typeof s.name !== "string")) throw new Error("Invalid Codex MCP inventory");
  const names = servers.map((s) => s.name as string).filter((name) => name !== "butchr");
  if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error("Unsupported Codex MCP server name; cannot isolate workers");
  return servers.filter((s) => s.name !== "butchr").map((s) => {
    const transport = s.transport?.type;
    if (transport !== "stdio" && transport !== "streamable_http") throw new Error("Unknown Codex MCP transport");
    return { name: s.name, transport };
  });
}
export const kickoffFor = (provider: AgentProvider): string => provider === "codex" ? "follow your AGENTS.md" : KICKOFF_PROMPT;

/**
 * The exact argv butchr spawns a claude agent with, for `spec` running in
 * `dir`. The ONE place this array is built — HerdrHerd.spawn() and the
 * staleness check both call it, so they cannot drift apart.
 *
 * The kickoff positional MUST stay first: --dangerously-load-development-channels
 * (and --mcp-config) are variadic and swallow a trailing positional as one of
 * their own entries (CHANGELOG 0.5.6).
 */
export function spawnArgs(spec: SpawnSpec, dir: string, agent: AgentConfig = { provider: "claude" }, mcpUrl = "http://localhost:7717/mcp"): string[] {
  if (agent.provider === "codex") return [
    kickoffFor(agent.provider), ...(agent.model ? ["--model", agent.model] : []),
    "--cd", dir, "--dangerously-bypass-approvals-and-sandbox",
    "--config", `mcp_servers.butchr={ url = ${JSON.stringify(mcpUrl)}, http_headers = { "x-issue" = ${JSON.stringify(spec.key)}, "x-butchr-provider" = "codex" }, enabled = true }`,
    ...(agent.disabledMcpServers ?? []).flatMap(({ name, transport }) => ["--config",
      `mcp_servers.${name}={enabled=false,${transport === "stdio" ? 'command="false"' : 'url="http://127.0.0.1:9/disabled"'}}`]),
  ];
  return [
    KICKOFF_PROMPT,
    "--model", agent.model ?? modelFor(spec.issuetype),
    "--effort", effortFor(spec.issuetype),
    "--permission-mode", "bypassPermissions",
    "--mcp-config", dir + "/mcp.json",
    "--dangerously-load-development-channels", "server:butchr",
  ];
}

export type ArgvCheck = { ok: true } | { ok: false; reason: string };

/**
 * Flags that must survive a herdr restore verbatim. `--model`, `--effort`,
 * and the kickoff positional are startup-only and deliberately excluded: a
 * `modelFor()`/`effortFor()` change on deploy must not churn the whole fleet.
 */
const REQUIRED_FLAGS = ["--permission-mode", "--mcp-config", "--dangerously-load-development-channels"] as const;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Pure argv health check: does `observed` (a claude process's real argv, or
 * just its flags) carry the same butchr-owned flags as `expected` (built by
 * `spawnArgs`)? Missing/mismatched flags are named in `reason`, in
 * `REQUIRED_FLAGS` order, exactly as they'd appear on the command line —
 * that string doubles as the daemon's `[reconcile]` log line and the
 * `[butchr:respawn]` ticket notice.
 */
export function checkArgv(expected: readonly string[], observed: readonly string[]): ArgvCheck {
  const missing: string[] = [];
  if (expected.includes("--dangerously-bypass-approvals-and-sandbox")) {
    if (!observed.includes("--dangerously-bypass-approvals-and-sandbox")) missing.push("--dangerously-bypass-approvals-and-sandbox");
    for (const flag of ["--cd", "--config"]) {
      const wants = expected.flatMap((value, i) => value === flag ? [expected[i + 1]] : []);
      const values = observed.flatMap((value, i) => value === flag ? [observed[i + 1]] : []);
      for (const want of wants) if (!values.includes(want)) missing.push(`${flag} ${want}`);
    }
  }
  for (const flag of REQUIRED_FLAGS) {
    const want = flagValue(expected, flag);
    if (want === undefined) continue; // spawnArgs always sets these; nothing to compare against
    if (flagValue(observed, flag) !== want) missing.push(`${flag} ${want}`);
  }
  return missing.length ? { ok: false, reason: `argv lacks ${missing.join(", ")}` } : { ok: true };
}
