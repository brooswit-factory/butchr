import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, AgentProvider } from "./argv.js";
// Bun embeds these at build time, so the built binary carries its briefs.
import CLAUDE_MD from "../../briefs/CLAUDE.md" with { type: "text" };
import AGENTS_MD from "../../briefs/AGENTS.md" with { type: "text" };
import EPIC from "../../briefs/epic.md" with { type: "text" };
import STORY from "../../briefs/story.md" with { type: "text" };
import TASK from "../../briefs/task.md" with { type: "text" };
import BUG from "../../briefs/bug.md" with { type: "text" };
import PROJECT from "../../briefs/project.md" with { type: "text" };
import DEFAULT from "../../briefs/default.md" with { type: "text" };
import { buildIdentity } from "./build-identity.js";
import { computeBuildCurrency } from "./build-currency.js";
import { deriveGroundTruth, groundTruthText } from "./ground-truth.js";
import { decodeAgentKey, decodeAnyAgentKey, decodeQueryAgentKey } from "../rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../rules/session-definition-type.js";
import type { AgentPreference, McpServerBinding } from "../rules/rules.js";
import { codexReasoningEffortFlag } from "../resources/power-scale.js";

/**
 * `key` is the herd identity: a rule-engine agent key
 * (`jira-work:<rule>:<ISSUE>`, see src/rules/agent-key.ts), or — for the
 * legacy/test callers that predate rules — a bare resource key. The optional
 * fields are set only for rule-engine agents: `resource` is the Jira key the
 * agent works (what MCP tools see as `x-issue`), `brief` replaces the
 * issue-type brief, `agents` is the rule's ranked harness preference, and
 * `mcpServers` is the rule's additional MCP server bindings (BUTCHR-411,
 * `Rule.mcpServers` — src/rules/rules.ts), each launched alongside butchr's
 * own server and (for `channel: true` entries) added to Claude's development
 * channels. Absent/empty means none — today's behaviour exactly.
 */
export interface SpawnSpec {
  key: string;
  issuetype: string;
  summary: string;
  parent: string | null;
  resource?: string;
  brief?: string;
  agents?: readonly AgentPreference[];
  /**
   * Rocket.Chat account name for THIS launch (BUTCHR-412 S4 design
   * correction — BUTCHR-391 comment 24007) — set only by the reconcile-layer
   * account hook (`src/agents/account-lifecycle.ts`), never by a
   * `specFor*` function, and only after `ensureAccount` actually succeeded
   * for this agent's rule policy. Carries NO credential: rocketr (Nexus's
   * bridge) holds every token centrally, and an agent's own MCP binding
   * names only its account, non-secret, in the `x-rocketr-account` header —
   * see `resolveAccountHeader`/`McpServerBinding.accountHeader` below for
   * how a per-agent literal (as opposed to BUTCHR-411's per-RULE
   * `headersEnvVar`) reaches that header, and `docs/rocketchat-accounts.md`'s
   * "Wiring" section for why. Superseded design (kept only in history, never
   * revived): an earlier round of this ticket delivered a per-agent token in
   * a dedicated 0600 file (`RC_ACCOUNT_FILE`) that the agent itself read —
   * removed per the corrected design, which forbids a token ever reaching an
   * agent's workspace at all.
   *
   * BUTCHR-413's own consumers of this SAME field, outside any one launch's
   * spec: `HerdrHerd.spawn`/`HerdrHerd.staleIssues` (src/agents/herd.ts) fill
   * this in ONLY when `ensure()` above never ran for a launch at all (no
   * accountLifecycle wired — RC not configured for any rule), and never
   * overwrite an already-set value; `createCodexChannelRelayPool`'s own
   * daemon-side connection (src/notify/codex-channel-relay.ts) has no live
   * spec to read at all and always derives it. Both use the exact same
   * `rcUsernameFor(agentKey, prefix)` this field's own real producer
   * (`ensureAccount`) uses internally, with the SAME configured
   * `Config.rocketchat.managedPrefix` — one function, one prefix, so a
   * derived answer can never name a different account than the one actually
   * provisioned.
   */
  rocketchatAccount?: string;
  /** Operator-owned MCP config path (jira-project rules only); `{{KEY}}` expands to the resource key. */
  mcpConfigFile?: string;
  /** Proxied external MCP connections prepared from `mcpConfigFile` (src/agents/resource-connections.ts). */
  externalMcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
  /**
   * BUTCHR-408: where a managed-session agent should actually WORK — a
   * Bakr agent's own project directory, never a synthetic
   * `<workspaceRoot>/filesystem/...` bookkeeping tree.
   *
   * PR #394 review, round 3 — NOT the launched process's own OS-level cwd,
   * despite an earlier version of this comment (and this ticket's own
   * text) saying so. Two independent, load-bearing invariants make that
   * unsafe, both discovered live reproducing this exact ticket's own
   * staged spawn test through the REAL `HerdrHerd` + `@brooswit/drovr`
   * `ManagedHerdrLifecycle` (not a stub — see test/unit/herd.test.ts):
   *
   * 1. `ManagedHerdrLifecycle` (`herd.ts`'s `lifecycle()`) is constructed
   *    with ONE fixed `cwd` — always `workspaceDirFor(issue)` — and
   *    HARD-REQUIRES the prepared launch's own `cwd` to equal it exactly
   *    (`"Launch does not match selected provider and workspace"` if not).
   *    It uses that SAME `cwd` to create the herdr workspace/pane AND as
   *    the residency key it scans `herdr.agent.list()` against. There is
   *    no seam in Drovr's current API for "the pane's OS cwd differs from
   *    its own workspace identity."
   * 2. `HerdrHerd.runningIssues()`/`byIssue()` (this file's own
   *    `agentIdOfWorkspacePath`) reverse-maps a live pane's cwd back to an
   *    agent id by assuming the fixed `workspaceDirFor` 1-or-3-deep shape.
   *    A pane at an ARBITRARY operator directory returns `null` there — it
   *    would be permanently invisible to `runningIssues()`, which EVERY
   *    reconciliation call (`scopedHerd`, admission residency, the
   *    daemon's own no-double-owner guarantee) is built on. This is core,
   *    heavily-shared daemon machinery every other provider also depends
   *    on — not something to patch around under review pressure.
   *
   * Given both, the launched process's cwd is ALWAYS `workspaceDirFor`
   * (unchanged for every existing and managed-session spec alike — see
   * `agentLaunchConfig`, src/agents/argv.ts). `cwd` here is instead
   * communicated to the agent through its own KICKOFF instructions
   * (`kickoffFor`, src/agents/argv.ts): told explicitly to `cd` there
   * before doing anything else. `buildWorkspace` (below) still always
   * writes CLAUDE.md/AGENTS.md/brief.md/mcp.json/ENVIRONMENT.md to
   * `workspaceDirFor(spec.key)`, exactly as it does for every other spec —
   * never into `cwd`, for the SAME reason as before (PR #394 review, round
   * 1): `cwd` names an OPERATOR's own project directory, which may already
   * hold its own `CLAUDE.md`/`AGENTS.md`, and butchr writing its own
   * bookkeeping files there would silently destroy them — see
   * `docs/managed-sessions.md`'s "Working directory wiring".
   *
   * Absent (the default for every existing caller), behaviour is
   * byte-for-byte unchanged: `kickoffFor` falls straight through to its
   * ordinary `"follow your CLAUDE.md"`/`"follow your AGENTS.md"` string.
   */
  cwd?: string;
  /** BUTCHR-408: `ClaudeAgentLaunch.permissionMode` passthrough (Drovr; untyped string there, validated at OUR layer before it ever reaches launch — see src/resources/session-definition.ts's `SESSION_PERMISSION_MODES`). Claude only: `CodexAgentLaunch` has no such field (see `agentLaunchConfig`, src/agents/argv.ts). Absent means today's behaviour exactly — no `permissionMode` is sent, same as before this ticket. */
  permissionMode?: string;
  /** BUTCHR-453/BUTCHR-463: `ClaudeAgentLaunch.strictMcpConfig` passthrough (`@brooswit/drovr` — emits `--strict-mcp-config` alongside `--mcp-config`, so Claude Code loads ONLY this agent's own `mcp.json`). Claude only, same as `permissionMode` above — a `vendor: "codex"` definition is REJECTED at manifest load rather than silently ignored (src/resources/session-definition.ts), a deliberate departure from `permissionMode`'s own silent-ignore precedent (see that field's own doc comment there for why). Absent means today's behaviour exactly — no flag, ordinary MCP discovery. */
  strictMcpConfig?: boolean;
  /**
   * BUTCHR-408: additional MCP servers this agent may connect to, beyond
   * butchr's own — a managed-session definition's own `mcpServers`
   * (src/resources/session-definition.ts). `McpServerBinding` (src/rules/rules.ts)
   * was ported there from S4's (BUTCHR-395/BUTCHR-411) branch as source
   * material per the epic's sequencing decision; when S4's own
   * `Rule.mcpServers` lands it should reach `SpawnSpec` through this SAME
   * field, not a second one — see `boundChannels`/`boundCodexServers`
   * (src/agents/argv.ts) for how a binding turns into launch argv, and
   * `resolveMcpServerHeaders`/`workspaceMcpServers` below for how a header
   * VALUE is kept out of everywhere but this daemon's own environment and a
   * Claude workspace's `mcp.json`. Absent/empty means none — today's
   * behaviour exactly.
   */
  mcpServers?: readonly McpServerBinding[];
}


/** The resource an agent works: `spec.resource` for a rule-engine agent, else the key itself. */
export const resourceOfSpec = (spec: SpawnSpec): string => spec.resource ?? spec.key;

const BRIEF_BY_TYPE: Readonly<Record<string, string>> = { epic: EPIC, story: STORY, task: TASK, bug: BUG, project: PROJECT };

/**
 * BUTCHR-169: every placeholder `interpolate()` is capable of substituting
 * into a workspace file — the type-level door `src/workspace/registry.ts`
 * mirrors (see that file's header for the rule this joins, and why the
 * registry lives there, not here). This array is the hand-written source of
 * truth (a closed union has to start somewhere written down), and what
 * keeps it from silently drifting from what `interpolate()` actually
 * substitutes is the OTHER direction of the tie: `interpolate()`'s own
 * substitution table (`values`, below) is typed `Record<WorkspacePlaceholder,
 * string>`, so adding a `.replaceAll`-worthy name to `values` without adding
 * it here is an excess-property error, and adding a name here without a
 * matching `values` entry fails to compile for the opposite reason (`Record`
 * requires every key). `src/workspace/registry.ts` imports this type FROM
 * here — never the reverse — so this write path never depends on the
 * registry, same "no runtime behaviour lives in the registry"
 * discipline `src/headers/registry.ts` documents for its own medium.
 */
export const WORKSPACE_PLACEHOLDERS = ["KEY", "SUMMARY", "TYPE", "PARENT", "GROUND_TRUTH"] as const;
export type WorkspacePlaceholder = (typeof WORKSPACE_PLACEHOLDERS)[number];

/**
 * Selected by `issuetype` — the SAME lookup an issue resource and a PROJECT
 * resource both go through (BUTCHR-71): an issue names its Jira issue type
 * here ("Epic"/"Story"/"Task"), and a project resource's spawn config names
 * `"project"` where an issue would name its type, so this one table serves
 * both without a second selection mechanism. Verify against BUTCHR-64's
 * spawn-config work before assuming the caller shape reaching this function
 * hasn't moved — this file only adds the `project` entry additively.
 */
export const briefFor = (issuetype: string): string => BRIEF_BY_TYPE[issuetype.toLowerCase()] ?? DEFAULT;

/**
 * The issue-type keys `briefFor` maps explicitly (lowercase). Every other
 * `issuetype` falls back to `DEFAULT`, which this deliberately excludes —
 * `DEFAULT` isn't a tracked brief, it's what "nothing more specific applies"
 * looks like. Exposed so a caller (BUTCHR-149: test/unit/merge-check-guard.test.ts)
 * can derive "every brief this fleet actually ships" from this table instead
 * of hand-copying a parallel list here that goes stale the moment a type is
 * added above — which is exactly how `briefs/project.md` went uncovered.
 */
export const knownBriefTypes = (): string[] => Object.keys(BRIEF_BY_TYPE);

/** A rule's `brief` of the form `@builtin:<type>` names one of the shipped briefs above instead of inline text. */
export const BUILTIN_BRIEF_PREFIX = "@builtin:";

/** A rule's brief as the agent gets it: a `@builtin:<type>` reference resolved to that shipped brief, any other text as-is. */
export const resolveRuleBrief = (brief: string): string =>
  brief.startsWith(BUILTIN_BRIEF_PREFIX) ? briefFor(brief.slice(BUILTIN_BRIEF_PREFIX.length)) : brief;

/**
 * Why a rule's brief is unusable, or null. Only `@builtin:` references are
 * checked: an unknown type would otherwise fall back to DEFAULT silently, so a
 * typo like `@builtin:stroy` must fail the rules file at load instead.
 */
export const builtinBriefProblem = (brief: string): string | null => {
  if (!brief.startsWith(BUILTIN_BRIEF_PREFIX)) return null;
  const type = brief.slice(BUILTIN_BRIEF_PREFIX.length);
  return knownBriefTypes().includes(type.toLowerCase())
    ? null
    : `names unknown built-in brief "${type}" (known: ${knownBriefTypes().join(", ")})`;
};

/** `groundTruth` fills `{{GROUND_TRUTH}}` (only CLAUDE.md carries that placeholder); omit it for templates that don't need it. */
export const interpolate = (template: string, spec: SpawnSpec, groundTruth?: string): string => {
  const values: Record<WorkspacePlaceholder, string> = {
    KEY: spec.key,
    SUMMARY: spec.summary,
    TYPE: spec.issuetype,
    PARENT: spec.parent ?? "(none — you are top-level)",
    GROUND_TRUTH: groundTruth ?? "",
  };
  return WORKSPACE_PLACEHOLDERS.reduce((acc, name) => acc.replaceAll(`{{${name}}}`, values[name]), template);
};

/** Model per issue type: epics think hardest, tasks run fast. A project resource (BUTCHR-71) gets the SAME tier an epic gets, not the task default — it makes epic-level product judgment, not fast mechanical work. */
export const modelFor = (issuetype: string): string =>
  ({ epic: "opus", story: "opus", task: "sonnet", project: "opus" } as Record<string, string>)[issuetype.toLowerCase()] ?? "sonnet";

/** Effort per issue type: all types run high for now, project (BUTCHR-71) included. */
export const effortFor = (issuetype: string): string =>
  ({ epic: "high", story: "high", task: "high", project: "high" } as Record<string, string>)[issuetype.toLowerCase()] ?? "high";

export const workspaceRoot = (): string => process.env.BUTCHR_WORKSPACES ?? join(homedir(), "butchr-workspaces");

/**
 * Where an agent's workspace lives. A rule-engine agent key — per-resource
 * (`encodeAgentKey`) or query-level (`encodeQueryAgentKey`, BUTCHR-397) —
 * maps to `<root>/<provider>/<ruleId>/<resourceId-or-"%40query">` (each
 * segment already URI-escaped by the key codec, so the key's `:`-joined
 * parts ARE the path segments). Anything else keeps the legacy `<root>/<id>`
 * layout. The two layouts cannot collide: a legacy directory is one level
 * deep, a rule-engine one is three — so a legacy workspace is never reused,
 * rewritten, or adopted by a rule agent for the same ticket. A query-level
 * workspace sits as a SIBLING of that same rule's per-resource ones, never
 * their ancestor (see `QUERY_AGENT_MARKER`'s own comment in agent-key.ts).
 */
export function workspaceDirFor(id: string, root: string = workspaceRoot()): string {
  return decodeAnyAgentKey(id) ? join(root, ...id.split(":")) : join(root, id);
}

/**
 * The herd id owning `cwd`, inverse of `workspaceDirFor`: a canonical agent
 * key (per-resource or query-level) for a three-deep rule-engine workspace,
 * the upper-cased directory name for a legacy one-deep workspace, `null` for
 * anything else. Legacy ids are still reported so legacy agents stay visible
 * (dashboard, admission census); the rule loop's `ownsId` is what keeps it
 * from ever stopping or adopting them.
 */
export function agentIdOfWorkspacePath(cwd: string | null | undefined, root: string = workspaceRoot()): string | null {
  if (!cwd) return null;
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  if (segments.length === 1) return segments[0]!.toUpperCase();
  if (segments.length !== 3) return null;
  const key = segments.join(":");
  return decodeAnyAgentKey(key) ? key : null;
}

/**
 * The rule-engine agent owning `cwd`, of ANY provider — never a legacy
 * one-deep workspace. For provider-neutral pane care (session-limit
 * recovery) that every rule loop's agents need, unlike the Jira-writing
 * detectors, which scope themselves to `jira-work`. Recognises a
 * query-level agent's workspace too (BUTCHR-397): it needs the same pane
 * care as any other rule-engine agent.
 */
export function ruleAgentIdOfWorkspacePath(cwd: string | null | undefined, root: string = workspaceRoot()): string | null {
  const id = agentIdOfWorkspacePath(cwd, root);
  return id && decodeAnyAgentKey(id) ? id : null;
}

/** The resource (Jira key) a herd id works: the decoded resource of an agent key, else the id itself. */
export const resourceKeyOf = (id: string): string => decodeAgentKey(id)?.resourceId ?? id;

/**
 * BUTCHR-398 (review finding 1) — the resourceKeyOf hazard's sharpest miss:
 * a caller that needs a REAL, single resource to write to or read from (a
 * Jira comment, a Confluence page) must NEVER fall back to `resourceKeyOf`'s
 * own whole-key fallback for a query-level id, the way `resourceKeyOf`
 * itself does for a legacy/bare-issue id. A query-level agent has no single
 * resource at all — that fallback would hand a caller its own bogus
 * `<provider>:<ruleId>:%40query` key as if it were a real one, exactly the
 * shape `speakOnOwnChannel`/`ops.addComment` cannot do anything useful with
 * (a 404, silently logged, and the write — an escalation, in the one
 * measured case — never reaches anyone). `null` here is the loud, honest
 * answer: it routes a caller through whatever "I have no resource to write
 * to" path it already has for an unowned/legacy id (e.g.
 * `src/agents/escalation-loop.ts`'s own `issue === null` branch, which logs
 * "cannot escalate" rather than attempting a write) — NEVER a silent 404.
 * `id` here is expected to already be OWNED (e.g. `ownsRuleAgent(id)` true)
 * — this function only ever narrows "owned" down to "owned AND has a single
 * resource", never widens an unowned id into anything.
 */
export const singleResourceOf = (id: string): string | null => (decodeQueryAgentKey(id) ? null : resourceKeyOf(id));

/**
 * Create the agent's workspace: CLAUDE.md (generic pointer, interpolated so
 * it can carry ground truth), brief.md (type-specific, interpolated),
 * mcp.json (connects back to butchr, identifying the issue), and
 * ENVIRONMENT.md (the same ground truth, standalone). Returns the
 * directory — the agent's cwd.
 */
/**
 * PR #394 review fix (Nexus MCP isolation, round 2): the round-1 guarantee
 * ("butchr never writes a `.mcp.json`") was necessary but not sufficient —
 * Claude's own `--mcp-config` is ADDITIVE to its ordinary project-level
 * `.mcp.json` discovery (`@brooswit/drovr` never passes
 * `--strict-mcp-config`; verified by grepping its own built argv builder),
 * and that discovery walks UP from the launched process's OWN cwd through
 * every ancestor directory, not just the cwd itself. Since a managed-session
 * agent's launched cwd is ALWAYS `workspaceDirFor(spec.key)` (never
 * `spec.cwd` — see that field's own doc comment), a `.mcp.json` sitting in
 * ANY ancestor of THAT directory (`workspaceRoot()`, its own parent, …) —
 * not `spec.cwd`/`workingDirectory`, which the launched process never
 * actually sits in or under — could still be inherited. Rather than assert
 * an unverified claim about Claude's exact discovery behaviour, this
 * GUARANTEES the property by refusing the spawn outright whenever the
 * (small, fixed) ancestor chain actually contains one, walking all the way
 * to the filesystem root — cheap (a handful of `existsSync` calls, once per
 * spawn attempt) and unconditional, no assumption required either way.
 * Scoped to managed-session specs only (`spec.cwd` set) per the review: a
 * BARE `jira-work`/other-provider spec's `workspaceDirFor` ancestor chain is
 * this same shared `workspaceRoot()` tree, but Nexus's own constraint was
 * raised specifically against "the definitions-directory design".
 */
export function assertNoInheritedMcpConfig(dir: string): void {
  let ancestor = dirname(dir);
  while (true) {
    if (existsSync(join(ancestor, ".mcp.json"))) {
      throw new Error(`managed-session workspace ${dir} would inherit ${join(ancestor, ".mcp.json")} — a managed-session agent's launched cwd must have NO .mcp.json anywhere in its ancestor chain (Nexus's MCP isolation constraint); remove or relocate that file before this definition can spawn`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached the filesystem root ("/")
    ancestor = parent;
  }
}

export function buildWorkspace(spec: SpawnSpec, mcpUrl: string, provider: AgentProvider = "claude", disabledMcpServers: AgentConfig["disabledMcpServers"] = []): string {
  // BUTCHR-408 review fix: NEVER `spec.cwd` — see `SpawnSpec.cwd`'s own doc
  // comment for why butchr's bookkeeping files must never land in an
  // operator's own project directory. `spec.cwd`, when present, only ever
  // reaches the launched PROCESS's cwd (`agentLaunchConfig`, src/agents/argv.ts).
  const dir = workspaceDirFor(spec.key);
  if (spec.cwd !== undefined) assertNoInheritedMcpConfig(dir);
  const resource = resourceOfSpec(spec);
  if (spec.externalMcpServers) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-external-mcp.json"),JSON.stringify(spec.externalMcpServers),{mode:0o600}); }
  // BUTCHR-408: `McpServerBinding` never carries a resolved header VALUE
  // (only `headersEnvVar`, an env var NAME) — see that type's own doc
  // comment (src/rules/rules.ts) — so, unlike `.butchr-external-mcp.json`
  // above, this file carries nothing secret and needs no tightened mode.
  // `staleIssues()` (src/agents/herd.ts) reads it back via
  // `workspaceMcpServers` (below) to rebuild the expected argv for an
  // already-running managed-session agent, the same "persist non-secret
  // spawn intent, re-derive it at staleness-check time" shape
  // `.butchr-external-mcp.json`/`workspaceExternalMcp` already established.
  if (spec.mcpServers) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-mcp-servers.json"),JSON.stringify(spec.mcpServers)); }
  // FACTORY-43: same "persist non-secret spawn intent, re-derive it at
  // staleness-check time" shape as `.butchr-mcp-servers.json` above —
  // `staleIssues()` was silently omitting `permissionMode`/`strictMcpConfig`
  // from its reconstructed expected argv (they were never persisted
  // anywhere it could read them back from), so a managed session launched
  // with a non-default permission mode was flagged stale, killed, and
  // respawned every poll forever.
  if (spec.permissionMode !== undefined) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-permission-mode.json"),JSON.stringify(spec.permissionMode)); }
  if (spec.strictMcpConfig !== undefined) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-strict-mcp-config.json"),JSON.stringify(spec.strictMcpConfig)); }
  // FACTORY-75: same "persist non-secret spawn intent, re-derive it at
  // staleness-check time" shape as `.butchr-permission-mode.json` above —
  // the two-axis (`modelPower`/`effort`) mechanism resolves to a concrete
  // `(model, effort)` pair PER PROVIDER this spec is actually launched
  // with (`spec.agents`, keyed by `harness`), so this reads the SAME entry
  // `startProviders`'s own `prepare()` callback picks (src/agents/herd.ts)
  // rather than assuming `spec.agents[0]`. `workspaceModel`/`workspaceEffort`
  // below are `staleIssues()`'s own read-back — what this workspace was
  // ACTUALLY spawned with, compared there against what the definition/rule
  // CURRENTLY resolves to (`resolvedAgentOf`), never against each other.
  const launchPreference = spec.agents?.find((p) => p.harness === provider);
  if (launchPreference?.model !== undefined) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-model.json"),JSON.stringify(launchPreference.model)); }
  if (launchPreference?.effort !== undefined) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-effort.json"),JSON.stringify(launchPreference.effort)); }
  // Templates always see the RESOURCE as {{KEY}} — the agent's ticket, not its herd identity.
  const view: SpawnSpec = { ...spec, key: resource };
  mkdirSync(dir, { recursive: true });
  if (provider === "codex") writeFileSync(join(dir, ".butchr-codex-isolation.json"), JSON.stringify(disabledMcpServers));
  const freeform = providerOf(spec) === "jira-project";
  if (provider === "codex" && (freeform || launchPreference?.effort !== undefined)) {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    // FACTORY-75: `model_reasoning_effort` is Codex's own config key for
    // reasoning effort (no CLI flag exists — see `codexReasoningEffortFlag`'s
    // own doc comment, src/resources/power-scale.ts, for how this was
    // confirmed and its caveats) — appended to the SAME per-workspace
    // config.toml the freeform (jira-project) path already writes
    // `approval_policy`/`sandbox_mode` into, rather than a second file, so
    // Codex only ever has ONE config source to reconcile here. Written
    // ONLY when this launch actually resolved an effort (the two-axis
    // `modelPower`/`effort` mechanism) — a `tier`-based (back-compat)
    // definition never reaches this line at all (`effectiveAgent` never
    // returns an `effort` for a Codex `tier` path — see that function's own
    // doc comment for why), which is what keeps a tier-based Codex
    // definition's launch free of any reasoning-effort override, exactly
    // as before this ticket.
    const reasoningEffortLine = launchPreference?.effort !== undefined ? `model_reasoning_effort = "${codexReasoningEffortFlag(launchPreference.effort)}"\n` : "";
    writeFileSync(join(dir, ".codex/config.toml"), (freeform ? 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\nsandbox_mode = "workspace-write"\n' : "") + reasoningEffortLine);
  }
  if (provider === "agy") {
    // BUTCHR-398: a query-level spec (no single resource, ANY provider) gets
    // its OWN shape — `agent` alone, no `resource`/`issue` field at all, so
    // `bridgeWorkspace` (src/mcp/workspace.ts) never hands a bogus key like
    // `jira-work:triage:%40query` to any tool expecting a real resource id.
    // Checked BEFORE `isKeyOnly`, which only ever answers for a per-resource
    // spec of a key-only PROVIDER — a query-level jira-work spec is neither
    // "resource" (no ticket) nor today's `isKeyOnly` shape (jira-work is not
    // a key-only provider), so it needs this third branch.
    const agyJson = isQuerySpec(spec) ? { agent: spec.key, mcpUrl } : isKeyOnly(spec) ? { agent: spec.key, resource, mcpUrl } : { issue: resource, ...(spec.resource ? { agent: spec.key } : {}), mcpUrl };
    writeFileSync(join(dir, ".butchr-agy.json"), JSON.stringify(agyJson, null, 2));
  }
  const groundTruth = groundTruthText(deriveGroundTruth(mcpUrl), buildIdentity, computeBuildCurrency(buildIdentity));
  writeFileSync(join(dir, provider === "claude" ? "CLAUDE.md" : "AGENTS.md"), freeform ? `# Project resource agent

You are a free-form assistant for project ${resource}. Read brief.md for the operator's instructions.
No ticket, Confluence page, task hierarchy, or autonomous workflow is implied by this role.
Await direction if your brief does not assign work. Preserve sandbox and approval review.
` : interpolate(provider === "claude" ? CLAUDE_MD : AGENTS_MD, view, groundTruth));
  writeFileSync(join(dir, "brief.md"), spec.brief !== undefined ? ruleBrief(spec, view) : interpolate(briefFor(spec.issuetype), view));
  if (provider === "claude") {
    // BUTCHR-408/BUTCHR-411/BUTCHR-412: a bound server (spec.mcpServers) lands in
    // mcp.json alongside butchr's own and any externalMcpServers, `channel:
    // true` or not — mcp.json is what gives Claude MCP TOOL access; the
    // channel flag (`boundChannels`, src/agents/argv.ts) is the separate,
    // additive decision about PUSH notifications. No bindings -> byte-identical
    // to before (Object.fromEntries([]) spreads nothing). A binding's headers
    // are the union of its (per-RULE, env-resolved, potentially secret)
    // `headersEnvVar` value and its (per-AGENT, always non-secret)
    // `accountHeader` value — see `resolveMcpServerHeaders`/
    // `resolveAccountHeader`'s own doc comments for why these are two
    // different resolution mechanisms sharing one binding shape, not two
    // competing ones.
    let hasSecretHeaders = false;
    const bound = Object.fromEntries((spec.mcpServers ?? []).map((b) => {
      const envHeaders = resolveMcpServerHeaders(b);
      if (envHeaders) hasSecretHeaders = true;
      const accountHeaders = resolveAccountHeader(b, spec.rocketchatAccount);
      const headers = envHeaders || accountHeaders ? { ...envHeaders, ...accountHeaders } : undefined;
      return [b.name, { type: b.type, url: b.url, ...(headers ? { headers } : {}) }];
    }));
    const mcpJsonPath = join(dir, "mcp.json");
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { butchr: { type: "http", url: mcpUrl, headers: mcpIdentityHeaders(spec) }, ...Object.fromEntries((spec.externalMcpServers ?? []).map((s) => [s.name, { type: "http", url: s.url, headers: s.headers }])), ...bound } }, null, 2));
    // Review finding, PR #387: a bound server's resolved header VALUE (often
    // a bearer token) must never sit in a group/other-readable file at the
    // default umask. `writeFileSync`'s own `mode` option only ever applies
    // when it CREATES the file (a rebuilt workspace's mcp.json already
    // exists), so this is an explicit chmod, not a write option, and only
    // when this write
    // actually carries a secret; a binding-less (or headers-less) mcp.json
    // keeps its exact previous permissions, untouched. `accountHeader`'s own
    // value (an account NAME, never a secret) never sets `hasSecretHeaders`
    // by itself — only `headersEnvVar`'s resolution does.
    if (hasSecretHeaders) chmodSync(mcpJsonPath, 0o600);
  }
  writeFileSync(join(dir, "ENVIRONMENT.md"), groundTruth);
  return dir;
}

/** The first line of a rule-engine brief — the only place a rule workspace snapshots the ticket's summary. */
export const ruleBriefHeader = (ruleId: string, resource: string, summary: string): string => `# ${ruleId} agent — ${resource}: ${summary}`;

/**
 * BUTCHR-398: `decodeAnyAgentKey`, not `decodeAgentKey` — a query-level
 * spec's `key` (`<provider>:<ruleId>:%40query`) never decodes as a
 * per-resource key by design (see `QUERY_AGENT_MARKER`'s own comment,
 * src/rules/agent-key.ts), so the old per-resource-only decoder silently
 * read every query-level spec as having NO provider at all — wrong for the
 * TOOLS_NOTE lookup below and for `isKeyOnly` (a jira-work query agent
 * legitimately has no `x-issue` to send either — see `mcpIdentityHeaders`).
 */
const providerOf = (spec: SpawnSpec) => decodeAnyAgentKey(spec.key)?.resourceProvider;
/** A query-level spec (`singleton`/`persistent`, BUTCHR-398): no single resource, of ANY provider — see `mcpIdentityHeaders`/`buildWorkspace`'s own use. */
const isQuerySpec = (spec: SpawnSpec): boolean => decodeQueryAgentKey(spec.key) !== null;
/** Agents identified to MCP by agent key alone — mirrors KEY_ONLY_PROVIDERS (src/mcp/identity.ts), kept local so workspace building loads no MCP code. */
const isKeyOnly = (spec: SpawnSpec): boolean => ["github-issue", "jira-idea", "zendesk-ticket", "jira-project", "filesystem"].includes(providerOf(spec) ?? "");

/** What a `github-issue` agent is told about its tools; a Jira brief carries no such section. */
export const GITHUB_ISSUE_TOOLS_NOTE =
  "Your resource is a GitHub issue, not a Jira ticket. Read it (title, body, type, comments) with the butchr `github_get_issue` tool and comment on it with `github_add_comment`; both act only on your own issue. When your rule is allowed to, `github_link_jira_idea` links your issue to an existing Jira Product Discovery idea. Jira and Confluence tools refuse you. You are told when the issue changes — re-read it then.";

/** What a `jira-idea` agent is told about its tools; a Jira work brief carries no such section. */
export const JIRA_IDEA_TOOLS_NOTE =
  "Your resource is a Jira Product Discovery idea, not a work item. Read it (summary, description, status, labels, comments) with the butchr `jira_idea_get` tool, list the GitHub issues its Jira remote links point at with `jira_idea_github_issues`, and comment on it with `jira_idea_add_comment`; all three act only on your own idea. When your rule is allowed to, `jira_idea_link_github_issue` links your idea to an existing GitHub issue. Jira work and Confluence tools refuse you. You are told when the idea changes — re-read it then.";

/** What a `zendesk-ticket` agent is told about its tools; a Jira work brief carries no such section. */
export const ZENDESK_TICKET_TOOLS_NOTE =
  "Your resource is a Zendesk support ticket, not a Jira ticket. Read it (subject, description, status, tags, public comments and internal notes) with the butchr `zendesk_get_ticket` tool and add a private internal note with `zendesk_add_internal_note`; both act only on your own ticket. You cannot reply to the customer: every note is internal, visible to Zendesk agents only. Jira, Confluence and GitHub tools refuse you. You are told when the ticket changes — re-read it then.";

/** What a `filesystem` agent is told about its tools; a Jira brief carries no such section. There are none: it reads/edits its resource directly with its own file tools (Read/Write/Edit/Bash), never a butchr MCP tool. NOT shown to a managed-session (`managed-sessions` rule) agent — see `MANAGED_SESSION_TOOLS_NOTE` below, which is the accurate note for that narrower case (BUTCHR-456 gives it exactly two conditional tools, not none). */
export const FILESYSTEM_TOOLS_NOTE =
  "Your resource is a file or directory on disk, not a Jira ticket. Read and edit it directly with your own file tools — there is no butchr MCP tool for it, and Jira, Confluence, GitHub and Zendesk tools all refuse you. You are told when it changes (created, modified, or removed) — re-read it from disk then.";

/**
 * BUTCHR-456: what a MANAGED-SESSION agent specifically is told — narrower
 * than `FILESYSTEM_TOOLS_NOTE` above, which would otherwise tell a
 * `director-brooswit-mud`-shaped agent "there is no butchr MCP tool for it"
 * even once its own definition IS granted freeze/unfreeze control over
 * another one, undermining the very capability this delegation exists to
 * give it. Shown to every managed-session agent regardless of whether it
 * currently holds any grant (a definition's OWN manifest is what actually
 * decides that at call time — this brief text is static per rule, like
 * every other `TOOLS_NOTE` entry, not re-derived per grant).
 */
export const MANAGED_SESSION_TOOLS_NOTE =
  "Your resource is a managed-session definition file, not a Jira ticket. Read and edit YOUR OWN definition directly with your own file tools — there is no general-purpose butchr MCP tool for it, and Jira, Confluence, GitHub and Zendesk tools all refuse you. The ONE exception: if ANOTHER definition's own `freezeControllers`/`unfreezeControllers` grant names your definition's file, you may call the butchr `freeze_session`/`unfreeze_session` tool (argument: that OTHER definition's name) to flip its freeze state. You have no other butchr MCP tool, and you can never edit any grant, or create, archive, or delete a definition — see docs/managed-sessions.md's \"Delegated freeze/unfreeze\" section. You are told when your own file changes (created, modified, or removed) — re-read it from disk then.";

const TOOLS_NOTE: Partial<Record<string, string>> = { "github-issue": GITHUB_ISSUE_TOOLS_NOTE, "jira-idea": JIRA_IDEA_TOOLS_NOTE, "zendesk-ticket": ZENDESK_TICKET_TOOLS_NOTE, "filesystem": FILESYSTEM_TOOLS_NOTE };

/**
 * A rule-engine brief: the rule's own text under a header naming the ticket.
 * `view` is the spec as templates see it ({{KEY}} is the resource, not the
 * agent key). The rule's brief is resolved (`@builtin:<type>` → that shipped
 * brief) and interpolated here, for every provider, so a shipped brief's
 * {{KEY}}/{{PARENT}}/… placeholders never reach the agent raw.
 */
const ruleBrief = (spec: SpawnSpec, view: SpawnSpec): string => {
  const decoded = decodeAnyAgentKey(spec.key);
  const note = decoded?.resourceProvider === "filesystem" && decoded.ruleId === MANAGED_SESSIONS_RULE_ID
    ? MANAGED_SESSION_TOOLS_NOTE
    : TOOLS_NOTE[decoded?.resourceProvider ?? ""];
  const body = interpolate(resolveRuleBrief(spec.brief!), view).trim();
  return `${ruleBriefHeader(decoded?.ruleId ?? "rule", view.key, spec.summary)}\n\n${note ? `${note}\n\n` : ""}${body}\n`;
};

/**
 * Headers identifying an agent to the butchr MCP server. `x-issue` is always
 * the resource (every tool resolves the caller's ticket from it);
 * `x-butchr-agent` is added for rule-engine agents so events and own-write
 * echoes are scoped to the one agent, not every agent on the same ticket.
 * A `github-issue`, `jira-idea` or `zendesk-ticket` agent sends only `x-butchr-agent` (src/mcp/identity.ts).
 *
 * BUTCHR-398: a query-level agent (`singleton`/`persistent`, ANY provider —
 * checked BEFORE `isKeyOnly`) sends only `x-butchr-agent` too, for the same
 * reason: it has no single resource, so `x-issue` would be
 * `resourceOfSpec(spec)`'s own fallback — the raw `%40query`-suffixed agent
 * key itself — which is exactly the bogus-issue-key hazard this ticket's
 * `resourceKeyOf` audit exists to close, one layer earlier (never produced
 * at all, rather than produced and then filtered downstream).
 */
export function mcpIdentityHeaders(spec: SpawnSpec): Record<string, string> {
  if (isQuerySpec(spec)) return { "x-butchr-agent": spec.key };
  // A GitHub issue or Zendesk ticket is not a Jira key, and an idea is not a work item: such an agent is identified by key alone, so no Jira work tool can resolve it as a ticket.
  if (isKeyOnly(spec)) return { "x-butchr-agent": spec.key };
  return { "x-issue": resourceOfSpec(spec), ...(spec.resource ? { "x-butchr-agent": spec.key } : {}) };
}

/**
 * Header VALUES for a bound MCP server (BUTCHR-408/BUTCHR-411, type ported
 * to main from S4's BUTCHR-395 branch — see `McpServerBinding`'s own doc
 * comment, src/rules/rules.ts), resolved from THIS DAEMON's own
 * environment — never from the rules/session-definition file, which only
 * ever names the env var (`McpServerBinding.headersEnvVar`). `env` defaults
 * to `process.env` for every real caller; tests pass an explicit map
 * instead of touching the process environment. Missing var, empty value,
 * invalid JSON, or JSON that isn't a flat string-valued object all resolve
 * to `undefined` (connect with no extra headers) rather than throwing — a
 * malformed/unset secret must not crash workspace building or launch.
 *
 * Review finding, PR #387: a `headersEnvVar` that resolves to nothing used
 * to fail this silently — for an authenticated bridge that is an agent that
 * connects unauthenticated and only fails later, with nothing pointing back
 * at the cause. `log` (default `console.error`, overridable for tests)
 * prints exactly one line naming the BINDING and the ENV VAR — never the
 * value, never the raw env content — whenever `headersEnvVar` was named but
 * produced no usable headers.
 */
export function resolveMcpServerHeaders(binding: McpServerBinding, env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.error): Record<string, string> | undefined {
  if (!binding.headersEnvVar) return undefined;
  const raw = env[binding.headersEnvVar];
  const parsed = raw ? tryParseHeaders(raw) : undefined;
  if (!parsed) log(`butchr: MCP server binding "${binding.name}" names headersEnvVar "${binding.headersEnvVar}", but it is unset, empty, or not a flat string-valued JSON object — connecting with no extra headers`);
  return parsed;
}

const tryParseHeaders = (raw: string): Record<string, string> | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === "string")) return parsed as Record<string, string>;
  } catch { /* malformed JSON in the env var — treated as absent, see doc comment above */ }
  return undefined;
};

/**
 * The PER-AGENT half of a bound server's headers (BUTCHR-412, BUTCHR-391
 * comment 24007) — `McpServerBinding.accountHeader`'s own doc comment
 * (`src/rules/rules.ts`) explains why this is a second, deliberately
 * separate resolution mechanism from `resolveMcpServerHeaders` above rather
 * than a second reading of the same one: that one resolves ONE static value
 * per RULE from the daemon's own env; this resolves a DIFFERENT value per
 * AGENT from `spec.rocketchatAccount` (set only by
 * `../agents/account-lifecycle.ts`'s `ensure`, after `ensureAccount`
 * actually provisioned this agent's account). No binding names an env var
 * here, and nothing is ever "malformed" — the value is either present
 * (this agent has an account) or it is not (no `accountHeader` on the
 * binding, or no account for this launch), so there is no failure mode to
 * log, unlike `resolveMcpServerHeaders`'s own unset/malformed-env case.
 *
 * BUTCHR-413 reuses this SAME function, unmodified, for Codex's own
 * bound-server config (`boundCodexServers`, src/agents/argv.ts) — safe
 * there in a way `resolveMcpServerHeaders`'s own resolved value never is,
 * because an account name grants no capability by itself (see
 * `McpServerBinding.accountHeader`'s own doc comment for why). One function,
 * two callers (Claude's mcp.json here, Codex's argv there), never a second
 * copy of the same one-line lookup.
 */
export function resolveAccountHeader(binding: McpServerBinding, account: string | undefined): Record<string, string> | undefined {
  return binding.accountHeader && account ? { [binding.accountHeader]: account } : undefined;
}

/** Non-secret launch inventory survives switching the daemon default back to Claude. */
export function workspaceIsolation(dir: string): AgentConfig["disabledMcpServers"] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, ".butchr-codex-isolation.json"), "utf8"));
    if (!Array.isArray(value) || value.some((s) => !s || typeof s.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(s.name) || !["stdio", "streamable_http"].includes(s.transport))) return undefined;
    return value;
  } catch { return undefined; }
}

export function workspaceExternalMcp(dir:string):SpawnSpec['externalMcpServers'] {
  try {return JSON.parse(readFileSync(join(dir,'.butchr-external-mcp.json'),'utf8'));}
  catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}

/**
 * BUTCHR-408: the persisted, non-secret counterpart of `workspaceExternalMcp`
 * above, for `spec.mcpServers` (`.butchr-mcp-servers.json`, `buildWorkspace`).
 * Lets `staleIssues()` (src/agents/herd.ts) rebuild an already-running
 * managed-session agent's expected argv (channel flags, Codex tool list)
 * without HerdrHerd holding any rule/definition state of its own — same
 * read-the-workspace-back shape, same reason.
 */
export function workspaceMcpServers(dir: string): SpawnSpec["mcpServers"] {
  try { return JSON.parse(readFileSync(join(dir, ".butchr-mcp-servers.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

/**
 * FACTORY-43: same read-the-workspace-back shape as `workspaceMcpServers`
 * above, for `spec.permissionMode` (`.butchr-permission-mode.json`,
 * `buildWorkspace`) — lets `staleIssues()` compare a managed-session agent's
 * argv against the permission mode it was ACTUALLY launched with, instead of
 * silently treating every such agent as if none had been requested.
 */
export function workspacePermissionMode(dir: string): SpawnSpec["permissionMode"] {
  try { return JSON.parse(readFileSync(join(dir, ".butchr-permission-mode.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

/** Same shape as `workspacePermissionMode` above, for `spec.strictMcpConfig` (`.butchr-strict-mcp-config.json`). */
export function workspaceStrictMcpConfig(dir: string): SpawnSpec["strictMcpConfig"] {
  try { return JSON.parse(readFileSync(join(dir, ".butchr-strict-mcp-config.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

/**
 * FACTORY-75 — same read-the-workspace-back shape as `workspacePermissionMode`
 * above, for the model this workspace was ACTUALLY launched with
 * (`.butchr-model.json`, `buildWorkspace`). `HerdrHerd.staleIssues()`'s own
 * `resolvedAgentOf` seam (src/agents/herd.ts) compares this against what
 * the definition/rule CURRENTLY resolves to, never against `proc.argv`
 * directly — `--model`/`--effort` are deliberately excluded from
 * `checkManagedAgentArgv`'s own comparison (`@brooswit/drovr`; see this
 * file's own `spawnArgs`/`agentLaunchConfig` doc comments and
 * `staleIssues()`'s doc comment for why issuetype-driven model/effort was
 * always excluded there), so this ticket's auto-reconcile-on-change
 * requirement needed its OWN comparison, not an extension of that one.
 */
export function workspaceModel(dir: string): string | undefined {
  try { return JSON.parse(readFileSync(join(dir, ".butchr-model.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

/** Same shape as `workspaceModel` immediately above, for the effort this workspace was ACTUALLY launched with (`.butchr-effort.json`). */
export function workspaceEffort(dir: string): AgentPreference["effort"] {
  try { return JSON.parse(readFileSync(join(dir, ".butchr-effort.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
