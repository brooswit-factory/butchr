import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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
import type { AgentPreference } from "../rules/rules.js";

/**
 * `key` is the herd identity: a rule-engine agent key
 * (`jira-work:<rule>:<ISSUE>`, see src/rules/agent-key.ts), or — for the
 * legacy/test callers that predate rules — a bare resource key. The optional
 * fields are set only for rule-engine agents: `resource` is the Jira key the
 * agent works (what MCP tools see as `x-issue`), `brief` replaces the
 * issue-type brief, and `agents` is the rule's ranked harness preference.
 */
export interface SpawnSpec {
  key: string;
  issuetype: string;
  summary: string;
  parent: string | null;
  resource?: string;
  brief?: string;
  agents?: readonly AgentPreference[];
  /** Operator-owned MCP config path (jira-project rules only); `{{KEY}}` expands to the resource key. */
  mcpConfigFile?: string;
  /** Proxied external MCP connections prepared from `mcpConfigFile` (src/agents/resource-connections.ts). */
  externalMcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
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
export function buildWorkspace(spec: SpawnSpec, mcpUrl: string, provider: AgentProvider = "claude", disabledMcpServers: AgentConfig["disabledMcpServers"] = []): string {
  const dir = workspaceDirFor(spec.key);
  const resource = resourceOfSpec(spec);
  if (spec.externalMcpServers) { mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,".butchr-external-mcp.json"),JSON.stringify(spec.externalMcpServers),{mode:0o600}); }
  // Templates always see the RESOURCE as {{KEY}} — the agent's ticket, not its herd identity.
  const view: SpawnSpec = { ...spec, key: resource };
  mkdirSync(dir, { recursive: true });
  if (provider === "codex") writeFileSync(join(dir, ".butchr-codex-isolation.json"), JSON.stringify(disabledMcpServers));
  const freeform = providerOf(spec) === "jira-project";
  if (freeform && provider === "codex") {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex/config.toml"), 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\nsandbox_mode = "workspace-write"\n');
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
  if (provider === "claude") writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { butchr: { type: "http", url: mcpUrl, headers: mcpIdentityHeaders(spec) }, ...Object.fromEntries((spec.externalMcpServers ?? []).map((s) => [s.name, { type: "http", url: s.url, headers: s.headers }])) } }, null, 2));
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
const isKeyOnly = (spec: SpawnSpec): boolean => ["github-issue", "jira-idea", "zendesk-ticket", "jira-project"].includes(providerOf(spec) ?? "");

/** What a `github-issue` agent is told about its tools; a Jira brief carries no such section. */
export const GITHUB_ISSUE_TOOLS_NOTE =
  "Your resource is a GitHub issue, not a Jira ticket. Read it (title, body, type, comments) with the butchr `github_get_issue` tool and comment on it with `github_add_comment`; both act only on your own issue. When your rule is allowed to, `github_link_jira_idea` links your issue to an existing Jira Product Discovery idea. Jira and Confluence tools refuse you. You are told when the issue changes — re-read it then.";

/** What a `jira-idea` agent is told about its tools; a Jira work brief carries no such section. */
export const JIRA_IDEA_TOOLS_NOTE =
  "Your resource is a Jira Product Discovery idea, not a work item. Read it (summary, description, status, labels, comments) with the butchr `jira_idea_get` tool, list the GitHub issues its Jira remote links point at with `jira_idea_github_issues`, and comment on it with `jira_idea_add_comment`; all three act only on your own idea. When your rule is allowed to, `jira_idea_link_github_issue` links your idea to an existing GitHub issue. Jira work and Confluence tools refuse you. You are told when the idea changes — re-read it then.";

/** What a `zendesk-ticket` agent is told about its tools; a Jira work brief carries no such section. */
export const ZENDESK_TICKET_TOOLS_NOTE =
  "Your resource is a Zendesk support ticket, not a Jira ticket. Read it (subject, description, status, tags, public comments and internal notes) with the butchr `zendesk_get_ticket` tool and add a private internal note with `zendesk_add_internal_note`; both act only on your own ticket. You cannot reply to the customer: every note is internal, visible to Zendesk agents only. Jira, Confluence and GitHub tools refuse you. You are told when the ticket changes — re-read it then.";

const TOOLS_NOTE: Partial<Record<string, string>> = { "github-issue": GITHUB_ISSUE_TOOLS_NOTE, "jira-idea": JIRA_IDEA_TOOLS_NOTE, "zendesk-ticket": ZENDESK_TICKET_TOOLS_NOTE };

/**
 * A rule-engine brief: the rule's own text under a header naming the ticket.
 * `view` is the spec as templates see it ({{KEY}} is the resource, not the
 * agent key). The rule's brief is resolved (`@builtin:<type>` → that shipped
 * brief) and interpolated here, for every provider, so a shipped brief's
 * {{KEY}}/{{PARENT}}/… placeholders never reach the agent raw.
 */
const ruleBrief = (spec: SpawnSpec, view: SpawnSpec): string => {
  const note = TOOLS_NOTE[providerOf(spec) ?? ""];
  const body = interpolate(resolveRuleBrief(spec.brief!), view).trim();
  return `${ruleBriefHeader(decodeAnyAgentKey(spec.key)?.ruleId ?? "rule", view.key, spec.summary)}\n\n${note ? `${note}\n\n` : ""}${body}\n`;
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
