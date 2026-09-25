import { decodeAgentKey } from "../rules/agent-key.js";
import { effortFor, mcpIdentityHeaders, modelFor, type SpawnSpec } from "./workspace.js";
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
/**
 * PR #394 review fix (round 2, revised): `spec` is optional and SECOND on
 * purpose — every existing caller passes only `provider`, and behaviour for
 * those calls is byte-for-byte unchanged (`spec` absent, or `spec.cwd`
 * absent, falls straight through to the ordinary `"follow your CLAUDE.md"`/
 * `"follow your AGENTS.md"` string every provider has always gotten).
 *
 * BUTCHR-408: a spec with `cwd` set (a managed-session definition) names
 * the directory the agent should actually WORK in — but (see
 * `SpawnSpec.cwd`'s own doc comment, src/agents/workspace.ts, for the full
 * story) the spawned PROCESS's own launch cwd stays the ordinary
 * bookkeeping directory; `cwd` is communicated to the agent through ITS
 * OWN kickoff instructions instead, explicitly telling it to `cd` there
 * before anything else, followed by its definition's own `brief` (its
 * whole prompt/role) — since with the process actually launched at
 * `spec.cwd`, `"follow your CLAUDE.md"` there would resolve to the
 * PROJECT's own file (if any), never butchr's generated one, and the
 * definition's `brief` would never reach the agent at all.
 */
export const kickoffFor = (provider: AgentProvider, spec?: SpawnSpec): string => {
  if (spec?.cwd && spec.brief) return `Your working directory for this task is ${spec.cwd} — cd there before doing anything else. Then: ${spec.brief}`;
  return provider === "claude" ? KICKOFF_PROMPT : "follow your AGENTS.md";
};

/**
 * Butchr supplies workspace intent; Drovr owns provider-specific process
 * arguments and returns the complete Herdr start contract. `dir` (the
 * bookkeeping directory, `buildWorkspace`'s return value) is ALWAYS the
 * launched process's own `cwd` here — `spec.cwd`, when a spec names one,
 * is deliberately NOT threaded into `cwd` below; see `SpawnSpec.cwd`'s own
 * doc comment (src/agents/workspace.ts) for why, and `kickoffFor` above
 * for how the agent still learns where to actually work.
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
      ...(decodeAgentKey(spec.key)?.resourceProvider === "jira-project" ? {bypassApprovalsAndSandbox:false}: {}),
      mcpServers: [{
        name: "butchr",
        url: mcpUrl,
        headers: { ...mcpIdentityHeaders(spec), "x-butchr-provider": "codex" },
      }, ...(spec.externalMcpServers ?? [])],
      disabledMcpServers: agent.disabledMcpServers ?? [],
    };
  }

  return {
    provider: "claude",
    ...(decodeAgentKey(spec.key)?.resourceProvider === "jira-project" ? {permissionMode:"auto"}: {}),
    name,
    paneId,
    cwd: dir,
    prompt: "",
    model: agent.model ?? modelFor(spec.issuetype),
    effort: agent.effort ?? effortFor(spec.issuetype),
    mcpConfigPath: dir + "/mcp.json",
    developmentChannels: ["server:butchr"],
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
  };
}

/** Compatibility helper for argv inspection; lifecycle dispatches kickoff separately. */
export function agentStartParams(
  spec: SpawnSpec, dir: string, paneId: string, name: string,
  agent: AgentConfig = { provider: "claude" }, mcpUrl = "http://localhost:7717/mcp",
): ParamsOf<"agent.start"> {
  return buildAgentStartParams({ ...agentLaunchConfig(spec, dir, paneId, name, agent, mcpUrl), prompt: kickoffFor(agent.provider, spec) });
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
