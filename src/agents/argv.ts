import { effortFor, modelFor, type SpawnSpec } from "./workspace.js";
import {
  buildAgentStartParams,
  type ManagedAgentProvider,
  type ParamsOf,
} from "@brooswit/drovr";

/** Claude Code's initial prompt, queued at startup and submitted once the startup dialogs are answered. */
export const KICKOFF_PROMPT = "follow your CLAUDE.md";
export type AgentProvider = ManagedAgentProvider;
export interface AgentConfig { provider: AgentProvider; model?: string; disabledMcpServers?: Array<{ name: string; transport: "stdio" | "streamable_http" }>; codexSpawnBlocked?: string }
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

/** Probe once at startup; inventory failure must not stop management of existing agents. */
export function inventoryCodexMcp(
  agent: AgentConfig,
  log: (line: string) => void,
  probe: () => { exitCode: number; stdout: { toString(): string } } = () => Bun.spawnSync(["codex", "mcp", "list", "--json"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 }),
): AgentConfig {
  if (agent.provider !== "codex") return agent;
  try {
    const result = probe();
    if (result.exitCode !== 0) throw new Error("inventory failed");
    const ready = { ...agent, disabledMcpServers: codexMcpServerNames(result.stdout.toString()) };
    delete ready.codexSpawnBlocked;
    return ready;
  } catch {
    const reason = "Codex MCP inventory unavailable or invalid; new Codex spawns disabled. Fix `codex mcp list --json` for the service user and restart Butchr. Existing workers remain managed; no automatic inventory retries.";
    log(reason);
    const blocked = { ...agent, codexSpawnBlocked: reason };
    delete blocked.disabledMcpServers;
    return blocked;
  }
}
export const kickoffFor = (provider: AgentProvider): string => provider === "codex" ? "follow your AGENTS.md" : KICKOFF_PROMPT;

/**
 * Butchr supplies workspace intent; Drovr owns provider-specific process
 * arguments and returns the complete Herdr start contract.
 */
export function agentStartParams(
  spec: SpawnSpec,
  dir: string,
  paneId: string,
  name: string,
  agent: AgentConfig = { provider: "claude" },
  mcpUrl = "http://localhost:7717/mcp",
): ParamsOf<"agent.start"> {
  if (agent.provider === "codex") {
    return buildAgentStartParams({
      provider: "codex",
      name,
      paneId,
      cwd: dir,
      prompt: kickoffFor(agent.provider),
      ...(agent.model ? { model: agent.model } : {}),
      mcpServers: [{
        name: "butchr",
        url: mcpUrl,
        headers: { "x-issue": spec.key, "x-butchr-provider": "codex" },
      }],
      disabledMcpServers: agent.disabledMcpServers ?? [],
    });
  }

  return buildAgentStartParams({
    provider: "claude",
    name,
    paneId,
    cwd: dir,
    prompt: kickoffFor(agent.provider),
    model: agent.model ?? modelFor(spec.issuetype),
    effort: effortFor(spec.issuetype),
    mcpConfigPath: dir + "/mcp.json",
    developmentChannels: ["server:butchr"],
  });
}

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
  return agentStartParams(spec, dir, "butchr-argv-probe", "butchr-argv-probe", agent, mcpUrl).args ?? [];
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
