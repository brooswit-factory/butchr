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
// Bun embeds this at build time, so the built binary carries it — same discipline as workspace.ts's own briefs/*.md imports.
import BEFORE_YOU_STOP from "../../briefs/_before-you-stop.md" with { type: "text" };

/**
 * FACTORY-892: herdr's `agent.start` rejects any start argument containing a
 * control character (C0 U+0000-U+001F or C1 U+007F-U+009F, matching
 * Rust's `char::is_control`) BEFORE it ever tries to shell-quote it —
 * observed as `invalid_agent_argument` / "agent arguments cannot be encoded
 * safely for the target shell". FACTORY-735/739 regressed exactly this: a
 * literal `\n\n` landed in the kickoff prompt, which is `args[0]` of every
 * `agent.start` call (`@brooswit/drovr`'s `buildAgentStartParams`). See
 * `kickoffFor` and `assertSafeStartArgv` below for where this is now
 * enforced butchr-side, before `agent.start` is ever called.
 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** Every control character in `args`, by index — empty when `args` is safe to hand to `agent.start`. */
export function controlCharStartArgs(args: readonly string[]): Array<{ index: number; value: string }> {
  return args.flatMap((value, index) => (CONTROL_CHAR_PATTERN.test(value) ? [{ index, value }] : []));
}

/**
 * The butchr-side pre-flight guard FACTORY-892 asks for: fails loudly, with
 * butchr's own message, instead of letting a control character reach herdr
 * and come back as an opaque `invalid_agent_argument` 4xx. Deliberately a
 * NEW function, not a change to `checkArgv`'s (`checkManagedAgentArgv`'s)
 * contract below — that one compares expected-vs-observed argv for
 * staleness and is not a validator; see its own re-export doc comment.
 */
export function assertSafeStartArgv(args: readonly string[]): void {
  const bad = controlCharStartArgs(args);
  if (bad.length === 0) return;
  const detail = bad.map(({ index, value }) => `args[${index}]=${JSON.stringify(value)}`).join(", ");
  throw new Error(`refusing to start agent: control character(s) in start argv — herdr rejects these before shell-quoting (${detail})`);
}

/**
 * FACTORY-940: `briefs/_before-you-stop.md` (and any other hand-written
 * Markdown source this feeds) opens with a `#`-style heading — stripped here
 * so it never survives flattening as a literal `##` sitting mid-sentence.
 * Only a LEADING marker is touched; the rest of the text is untouched.
 */
const MARKDOWN_LEADING_LINE_MARKER = /^(?:#{1,6}|>+|[-*+]|\d+\.)\s+/;

/** Collapses all whitespace (including newlines) to single spaces, so the result is always safe as ONE start argument. */
const flattenToSingleLine = (text: string): string =>
  text.trim().replace(MARKDOWN_LEADING_LINE_MARKER, "").replace(/\s+/g, " ");

/**
 * FACTORY-735/FACTORY-739: the shared "before you stop" reminder appended to
 * every kickoff prompt below, so it is in context from the agent's very
 * first turn — not just inside `brief.md` (which a long session's own
 * context compaction can push out) — and so it is still there at the moment
 * the agent is deciding whether to stop or go idle. Same shared source
 * (`briefs/_before-you-stop.md`) `src/agents/workspace.ts`'s own
 * `BEFORE_YOU_STOP_INCLUDE_MARKER` resolves into every `briefs/*.md`
 * template — this is the SECOND of the two places FACTORY-735 requires the
 * text to land, not a competing copy of it.
 *
 * FACTORY-892: flattened to one line (`flattenToSingleLine`, not just
 * `.trim()`) — `briefs/_before-you-stop.md` is hand-wrapped Markdown with
 * real newlines mid-sentence, and a multi-line kickoff is exactly the
 * regression this ticket fixes. See `CONTROL_CHAR_PATTERN`'s own doc
 * comment above for why.
 */
const KICKOFF_REMINDER = flattenToSingleLine(BEFORE_YOU_STOP);

/** Claude Code's initial prompt, queued at startup and submitted once the startup dialogs are answered. ONE LINE — see FACTORY-892 above. */
export const KICKOFF_PROMPT = `follow your CLAUDE.md. ${KICKOFF_REMINDER}`;
/** Codex/Agy's initial prompt — the non-Claude twin of `KICKOFF_PROMPT` above, same reminder appended. ONE LINE — see FACTORY-892 above. */
export const AGENTS_KICKOFF_PROMPT = `follow your AGENTS.md. ${KICKOFF_REMINDER}`;
/**
 * FACTORY-127/FACTORY-138 (operator decision, FACTORY-67 director comment
 * 2026-09-26 22:24Z): butchr's own default for a Claude launch whose spec
 * names no `permissionMode` — replacing reliance on Drovr's own
 * `launch.permissionMode ?? "bypassPermissions"` fallback
 * (`@brooswit/drovr`'s Claude arg builder). Exported so tests and any future
 * doc reference exactly one value rather than a repeated literal. Applied
 * ONLY inside `agentLaunchConfig` below — see that function's own doc
 * comment for why nowhere else is the right place. `acceptEdits` auto-
 * accepts file edits only; Bash/MCP tool-permission prompts still fire,
 * which is why this default NEVER ships without `lizardMode` also
 * defaulting to eligible (see `ruleLizardModeOf`,
 * src/agents/permission-answer-loop.ts, and the managed-session
 * `lizardModes` map fill, src/rules/session-definition-type.ts) — the
 * DROVR-37 freeze incident is what an accept-edits agent with no lizard
 * coverage looks like.
 */
export const DEFAULT_PERMISSION_MODE = "acceptEdits" as const;
export type AgentProvider = ManagedAgentProvider;
/**
 * FACTORY-491 (director item 5, FACTORY-467 comment 27774/27788): the
 * `BUTCHR_RESTORED_RESUME` canary/kill switch for herdr-restored-pane
 * resume-in-place (`isHerdrRestoredPane`, src/agents/herd.ts) — `"off"`
 * disables it fleet-wide (today's allowlist/stop+spawn behaviour,
 * unconditionally), `"all"` enables it for every managed session, and a
 * `ReadonlySet` enables it only for the named managed sessions (their bare
 * definition name — `managedSessionShortDisplayId`,
 * src/rules/session-definition-type.ts — e.g. `"buddy"`). Parsed once in
 * `loadConfig` (src/config/config.ts); see that parse for the default.
 */
export type RestoredResumePolicy = "off" | "all" | ReadonlySet<string>;
export interface AgentConfig {
  provider: AgentProvider; providers?: AgentProvider[]; roleProviders?: Partial<Record<"project" | "epic" | "story" | "task", AgentProvider[]>>; model?: string; effort?: string; disabledMcpServers?: Array<{ name: string; transport: "stdio" | "streamable_http" }>; codexSpawnBlocked?: string; agySpawnBlocked?: string;
  /** FACTORY-491 — see `RestoredResumePolicy`'s own doc comment. Defaults to `{buddy, genius}` in `loadConfig` when `BUTCHR_RESTORED_RESUME` is unset. */
  restoredResume?: RestoredResumePolicy;
  /**
   * FACTORY-314 (PR #513 review fix) — set ONLY by `HerdrHerd.resumeInPlace()`
   * (src/agents/herd.ts) for a model/effort-only change on a still-alive
   * Claude agent: the workspace's own DISCOVERED session id (its real,
   * Claude-assigned one — `discoverClaudeSessionId`, src/agents/workspace.ts
   * — never a butchr-minted one; a fresh launch has no `--session-id`
   * equivalent at all, see `agentStartParams`'s own doc comment below for
   * why), so `agentStartParams()` below emits `--resume <id>`. Absent for
   * every other caller (an ordinary fresh spawn, and `staleIssues()`'s own
   * expected-argv reconstruction), which is what keeps this a strict
   * addition: nothing about today's launch or staleness comparison changes
   * when this field is unset.
   */
  resumeSessionId?: string;
}

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
 *
 * FACTORY-892: this is the ONE function every start path (the real spawn
 * path's `kickoff` callback into `ManagedHerdrLifecycle.start()`, and
 * `agentStartParams`/`spawnArgs` below) calls to get the prompt that becomes
 * `args[0]` of `agent.start`. `spec.brief` is operator/rule-authored and can
 * be multi-line — the SAME class of break the two KICKOFF_PROMPT constants
 * had, just latent until a multi-line brief is used — so it is flattened
 * here too, and the result is asserted safe before it ever leaves this
 * function, as a backstop for any control character flattening doesn't
 * catch (e.g. a bare `\0`, which is not whitespace).
 */
export const kickoffFor = (provider: AgentProvider, spec?: SpawnSpec): string => {
  const prompt =
    spec?.cwd && spec.brief
      ? `Your working directory for this task is ${spec.cwd} — cd there before doing anything else. Then: ${flattenToSingleLine(spec.brief)}`
      : provider === "claude"
        ? KICKOFF_PROMPT
        : AGENTS_KICKOFF_PROMPT;
  assertSafeStartArgv([prompt]);
  return prompt;
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
      // FACTORY-577: today's rule is THREE cases, in precedence order:
      //   1. an EXPLICIT `spec.permissionMode` wins outright, in both
      //      directions, over everything below — `"bypassPermissions"` =>
      //      the bypass flag (set true explicitly, rather than resting on
      //      drovr's own `!== false` default, so the intent is legible here
      //      and in a test's assertion); any other explicit mode
      //      (`"default"`/`"acceptEdits"`/`"plan"`/`"auto"`) => manual.
      //   2. ABSENT `spec.permissionMode`: the pre-existing unconditional
      //      jira-project case (a freeform project manager's own
      //      always-manual review mode) => manual.
      //   3. ABSENT `spec.permissionMode`, not jira-project: `spec.lizardMode`
      //      is Codex's own "manual approval mode" launch signal (FACTORY-108
      //      — the Codex counterpart of Claude's `permissionMode: "default"`,
      //      Codex has no `permissionMode` concept of its own) — omitting the
      //      bypass flag is what lets the daemon's permission-answer timer's
      //      `autoAnswerCodexApprovals` pass (src/agents/permission-answer-loop.ts)
      //      ever see a pending dialog to answer at all (a bypassed launch
      //      shows none) — truthy => manual.
      // DELIBERATE SELF-CONTRADICTION, case 1 over case 3: a managed-session
      // definition can set `permissionMode: "bypassPermissions"` AND
      // `lizardMode: true` at once (`specForSessionDefinition` forwards
      // `lizardMode` for `vendor: "codex"` independently of the required
      // `permissionMode` field — src/rules/session-definition-type.ts). Case
      // 1 wins, so that pane launches bypassed — no approval dialog EVER
      // appears, which makes `lizardMode`'s auto-answering dead code for it.
      // This is intentional (FACTORY-577 decision, not an oversight): an
      // explicit `permissionMode` is a stronger, launch-time-legible signal
      // than `lizardMode`'s own manual-mode side effect, and a definition
      // author who sets both has asked for two contradictory things — YOLO
      // wins because it is the more specific, more recently-stated intent.
      // If a future story wants `lizardMode: true` to instead force manual
      // even over an explicit `bypassPermissions`, that is a precedence
      // change to make deliberately here, not something to fall out of
      // reordering this conditional.
      ...(spec.permissionMode !== undefined
        ? { bypassApprovalsAndSandbox: spec.permissionMode === "bypassPermissions" }
        : decodeAgentKey(spec.key)?.resourceProvider === "jira-project" || spec.lizardMode
          ? { bypassApprovalsAndSandbox: false }
          : {}),
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
    // FACTORY-138: butchr's own default; an explicit spec.permissionMode
    // further down still wins over it — see DEFAULT_PERMISSION_MODE's own
    // doc comment for why this is the one place the default belongs.
    // FACTORY-129: the jira-project-only "auto" override that used to sit
    // here is gone — jira-project agents now inherit this default (and
    // lizard-mode eligibility) exactly like every other rule kind.
    permissionMode: DEFAULT_PERMISSION_MODE,
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

/**
 * Compatibility helper for argv inspection; lifecycle dispatches kickoff
 * separately.
 *
 * FACTORY-314 (PR #513 review fix): the ONE place `--resume` is appended.
 * IMPORTANT ASYMMETRY, unlike every other flag this function builds: this
 * function is NOT in the real fresh-launch path. `HerdrHerd.spawnExclusive`'s
 * `prepare()` hands `agentLaunchConfig(...)` straight to Drovr's
 * `ManagedHerdrLifecycle.start()`, which builds its OWN `agent.start` params
 * via Drovr's `buildAgentStartParams` — never this function — for a fresh
 * spawn (verified against the pinned 0.15.1 source: `buildAgentStartParams`'s
 * Claude branch has no `--session-id`/`--resume` concept at all, so a fresh
 * launch runs under Claude's OWN auto-generated session id, discovered
 * AFTERWARD from its transcript directory — see `discoverClaudeSessionId`,
 * src/agents/workspace.ts, and `HerdrHerd.startProviders`'s own doc comment
 * — never pre-declared here). This function IS the real launch builder for
 * exactly one caller: `HerdrHerd.resumeInPlace()`, which bypasses
 * `ManagedHerdrLifecycle` entirely and calls this directly — so `--resume`
 * appended HERE is real, but do not read the rest of this function's
 * "real launch AND staleness comparison agree" property as extending to a
 * flag that only matters for that one caller.
 */
export function agentStartParams(
  spec: SpawnSpec, dir: string, paneId: string, name: string,
  agent: AgentConfig = { provider: "claude" }, mcpUrl = "http://localhost:7717/mcp",
): ParamsOf<"agent.start"> {
  const params = buildAgentStartParams({ ...agentLaunchConfig(spec, dir, paneId, name, agent, mcpUrl), prompt: kickoffFor(agent.provider, spec) });
  if (agent.provider === "claude" && agent.resumeSessionId) {
    params.args = [...(params.args ?? []), "--resume", agent.resumeSessionId];
  }
  // FACTORY-892: belt-and-suspenders over the FULL argv, not just the
  // prompt `kickoffFor` already checked — every other value here is an
  // internal constant/enum today, never multi-line, but this is what makes
  // the guard cover "every start argument" as the ticket asks, not just the
  // one argument that happened to regress.
  assertSafeStartArgv(params.args ?? []);
  return params;
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
