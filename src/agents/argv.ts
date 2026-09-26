import { decodeAgentKey } from "../rules/agent-key.js";
import { effortFor, mcpIdentityHeaders, modelFor, resolveAccountHeader, type SpawnSpec } from "./workspace.js";
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
 * `server:<name>` for every `spec.mcpServers` entry with `channel: true`
 * (BUTCHR-408/BUTCHR-411 — the type landed independently on the main line
 * and on the BUTCHR-395 branch, then merged here; see `McpServerBinding`'s
 * own doc comment, src/rules/rules.ts) — the same channel-naming convention
 * `server:butchr` already uses. Order follows `spec.mcpServers`, so it's
 * deterministic for argv comparison (`checkArgv`/`staleIssues`). Empty when
 * `spec.mcpServers` is absent/empty — unaffected.
 */
const boundChannels = (spec: SpawnSpec): string[] => (spec.mcpServers ?? []).filter((s) => s.channel).map((s) => `server:${s.name}`);

/**
 * Codex `McpServerLaunchConfig` entries for `spec.mcpServers`
 * (BUTCHR-408/BUTCHR-411) — every binding, `channel` or not: Codex has no
 * development-channel concept (BUTCHR-359, out of scope here), so a bound
 * server reaches Codex as MCP TOOLS only, never push.
 *
 * DELIBERATELY never `headersEnvVar`'s resolved value, unlike
 * `spec.externalMcpServers` above: Drovr renders a Codex
 * `McpServerLaunchConfig`'s `headers` as `--config
 * mcp_servers.<name>={ ..., http_headers = {...} }` — a real process
 * command-line argument, visible to any other local user via `ps`/`/proc`,
 * and also the exact text `staleIssues()`/`onRespawn` echo verbatim into
 * `observedArgv` and the daemon journal (S4/PR #387 review finding).
 * `headersEnvVar` exists precisely so a header VALUE (often a bearer token)
 * is never written anywhere that isn't the daemon's own process environment
 * and the agent's own `mcp.json` (Claude only, see `buildWorkspace`'s 0600
 * handling) — Codex argv is exactly such an "anywhere else". A binding that
 * names ONLY `headersEnvVar` simply connects Codex to the bound server with
 * no extra headers; docs/managed-sessions.md and docs/mcp-server-bindings.md
 * both say so loudly, since an authenticated bridge then fails to
 * authenticate otherwise (`resolveMcpServerHeaders` itself, used only by
 * the Claude/`mcp.json` path below, already logs when a named var resolves
 * to nothing).
 *
 * BUTCHR-413 (review finding 1) IS an exception, deliberately: a binding's
 * `accountHeader` (see that field's own doc comment, src/rules/rules.ts)
 * carries only an account NAME, `spec.rocketchatAccount` — never a
 * bearer token — so `resolveAccountHeader` (src/agents/workspace.ts, the
 * SAME function `buildWorkspace` calls for Claude's `mcp.json`, reused here
 * verbatim rather than a second copy) reaches Codex argv here where
 * `headersEnvVar`'s own resolved value never does. This is what makes a
 * Codex agent's own reply through `rocketr`'s tools possible at all after
 * this same review's earlier fix (BUTCHR-411) struck every bound-server
 * header from a Codex launch: that fix is unweakened — `headersEnvVar`
 * still never reaches here — this only adds a second, narrower, non-secret
 * channel the earlier review never considered.
 */
const boundCodexServers = (spec: SpawnSpec): Array<{ name: string; url: string; headers?: Record<string, string> }> =>
  (spec.mcpServers ?? []).map((s) => {
    const headers = resolveAccountHeader(s, spec.rocketchatAccount);
    return { name: s.name, url: s.url, ...(headers ? { headers } : {}) };
  });

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
      mcpServers: [
        {
          name: "butchr",
          url: mcpUrl,
          headers: { ...mcpIdentityHeaders(spec), "x-butchr-provider": "codex" },
        },
        ...(spec.externalMcpServers ?? []),
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
    ...(decodeAgentKey(spec.key)?.resourceProvider === "jira-project" ? {permissionMode:"auto"}: {}),
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
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
    ...(spec.strictMcpConfig ? { strictMcpConfig: true } : {}),
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
