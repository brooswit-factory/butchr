import { effortFor, mcpIdentityHeaders, modelFor, resolveMcpServerHeaders, type SpawnSpec } from "./workspace.js";
import {
  buildAgentStartParams,
  checkManagedAgentArgv,
  inventoryCodexMcpServers,
  parseCodexMcpInventory,
  type ManagedAgentProvider,
  type ManagedAgentLaunch,
  type ParamsOf,
} from "@brooswit/drovr";

/** Claude Code's initial prompt, queued at startup and submitted once the startup dialogs are answered. */
export const KICKOFF_PROMPT = "follow your CLAUDE.md";
export type AgentProvider = ManagedAgentProvider;
export interface AgentConfig { provider: AgentProvider; providers?: AgentProvider[]; roleProviders?: Partial<Record<"project" | "epic" | "story" | "task", AgentProvider[]>>; model?: string; effort?: string; disabledMcpServers?: Array<{ name: string; transport: "stdio" | "streamable_http" }>; codexSpawnBlocked?: string; agySpawnBlocked?: string }

export function providerOrder(agent: AgentConfig, role: string): AgentProvider[] {
  return agent.roleProviders?.[role.toLowerCase() as "project" | "epic" | "story" | "task"] ?? agent.providers ?? [agent.provider];
}
/** Read-only inventory: never log its raw output, which can contain credentials. */
export function codexMcpServerNames(output: string): NonNullable<AgentConfig["disabledMcpServers"]> {
  return parseCodexMcpInventory(output, ["butchr"]);
}

/** Probe once at startup; inventory failure must not stop management of existing agents. */
export function inventoryCodexMcp(
  agent: AgentConfig,
  log: (line: string) => void,
  probe: () => { exitCode: number; stdout: { toString(): string } } = () => Bun.spawnSync(["codex", "mcp", "list", "--json"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 }),
): AgentConfig {
  if (![agent.provider, ...(agent.providers ?? []), ...Object.values(agent.roleProviders ?? {}).flat()].includes("codex")) return agent;
  const inventory = inventoryCodexMcpServers(["butchr"], probe);
  if (inventory.ok) {
    const ready = { ...agent, disabledMcpServers: inventory.servers };
    delete ready.codexSpawnBlocked;
    return ready;
  }
  const reason = "Codex MCP inventory unavailable or invalid; new Codex spawns disabled. Fix `codex mcp list --json` for the service user and restart Butchr. Existing workers remain managed; no automatic inventory retries.";
  log(reason);
  const blocked = { ...agent, codexSpawnBlocked: reason };
  delete blocked.disabledMcpServers;
  return blocked;
}
export const kickoffFor = (provider: AgentProvider): string => provider === "claude" ? KICKOFF_PROMPT : "follow your AGENTS.md";

/**
 * `server:<name>` for every `spec.mcpServers` entry with `channel: true`
 * (BUTCHR-411) — the same channel-naming convention `server:butchr` already
 * uses. Order follows `spec.mcpServers`, so it's deterministic for argv
 * comparison (`checkArgv`/`staleIssues`). Empty when `spec.mcpServers` is
 * absent/empty — the pre-BUTCHR-411 shape, unaffected.
 */
const boundChannels = (spec: SpawnSpec): string[] => (spec.mcpServers ?? []).filter((s) => s.channel).map((s) => `server:${s.name}`);

/**
 * Codex `McpServerLaunchConfig` entries for `spec.mcpServers` (BUTCHR-411) —
 * every binding, `channel` or not: Codex has no development-channel concept
 * (BUTCHR-359, out of scope here), so a bound server reaches Codex as MCP
 * TOOLS only, never push. Header values are resolved fresh from this
 * daemon's own environment each call (`resolveMcpServerHeaders`) — the same
 * env read `staleIssues()` and the original spawn share, so a value that
 * hasn't changed produces byte-identical argv both times.
 */
const boundCodexServers = (spec: SpawnSpec): Array<{ name: string; url: string; headers?: Record<string, string> }> =>
  (spec.mcpServers ?? []).map((s) => {
    const headers = resolveMcpServerHeaders(s);
    return { name: s.name, url: s.url, ...(headers ? { headers } : {}) };
  });

/**
 * Butchr supplies workspace intent; Drovr owns provider-specific process
 * arguments and returns the complete Herdr start contract.
 */
export function agentLaunchConfig(
  spec: SpawnSpec,
  dir: string,
  paneId: string,
  name: string,
  agent: AgentConfig = { provider: "claude" },
  mcpUrl = "http://localhost:7717/mcp",
): ManagedAgentLaunch {
  if (agent.provider === "agy") {
    return {
      provider: "agy",
      skipPermissions: true,
      name,
      paneId,
      cwd: dir,
      prompt: "",
      ...(agent.model ? { model: agent.model } : {}),
    };
  }
  if (agent.provider === "codex") {
    return {
      provider: "codex",
      name,
      paneId,
      cwd: dir,
      prompt: "",
      ...(agent.model ? { model: agent.model } : {}),
      mcpServers: [
        {
          name: "butchr",
          url: mcpUrl,
          headers: { ...mcpIdentityHeaders(spec), "x-butchr-provider": "codex" },
        },
        // BUTCHR-411: a rule's bound servers give a Codex agent the same MCP
        // TOOL access a Claude agent gets from mcp.json — never a channel
        // (Codex push is BUTCHR-359, out of scope here).
        ...boundCodexServers(spec),
      ],
      disabledMcpServers: agent.disabledMcpServers ?? [],
    };
  }

  return {
    provider: "claude",
    name,
    paneId,
    cwd: dir,
    prompt: "",
    model: agent.model ?? modelFor(spec.issuetype),
    effort: agent.effort ?? effortFor(spec.issuetype),
    mcpConfigPath: dir + "/mcp.json",
    // BUTCHR-411: `server:butchr` remains bound exactly as today, first;
    // a rule's `channel: true` bindings are additive. Drovr emits each as
    // its own `--dangerously-load-development-channels=server:x` flag (the
    // variadic form this file's own doc comment below warns about), so
    // multiple channel servers just work.
    developmentChannels: ["server:butchr", ...boundChannels(spec)],
  };
}

/** Compatibility helper for argv inspection; lifecycle dispatches kickoff separately. */
export function agentStartParams(
  spec: SpawnSpec, dir: string, paneId: string, name: string,
  agent: AgentConfig = { provider: "claude" }, mcpUrl = "http://localhost:7717/mcp",
): ParamsOf<"agent.start"> {
  return buildAgentStartParams({ ...agentLaunchConfig(spec, dir, paneId, name, agent, mcpUrl), prompt: kickoffFor(agent.provider) });
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

export { checkManagedAgentArgv as checkArgv };
