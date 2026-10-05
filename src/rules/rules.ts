/**
 * Resource-agent rules, first slice: configuration, validation, and the
 * stable agent key that names "the agent rule R runs on resource X".
 *
 * A rule is data, not hierarchy: a resource provider, a provider-native
 * query, a brief, ranked agent preferences, and relationships to OTHER RULES
 * by id. There is no role enum — what an epic or a subtask agent does lives
 * in its brief and in which rule its children match. Each matching resource
 * gets its own agent per rule, so several rules may cover one resource.
 *
 * Pure apart from the injectable `read` in `loadRules`, mirroring
 * `loadConfig`'s `readFile` seam. The daemon loads rules once at startup
 * and runs them through `./resource-type.ts`.
 *
 * Rules live in a JSON file OUTSIDE the repo: `BUTCHR_RULES_FILE` when set,
 * else `$XDG_CONFIG_HOME/butchr/rules.json`, else
 * `~/.config/butchr/rules.json`. When the DEFAULT file is absent there are
 * ZERO rules and nothing is staffed; nothing is written. An explicit
 * `BUTCHR_RULES_FILE` that does not exist is an error: a typo must never
 * read as "no rules" and stop every rule agent. There are no built-in
 * rules or templates — a present file is the only source of rules.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { builtinBriefProblem } from "../agents/workspace.js";
import { filesystemQueryProblems } from "../resources/filesystem-query.js";
import { githubIssueQueryProblems } from "../resources/github-issue.js";
import { githubPrQueryProblems } from "../resources/github-pr.js";
import { parseProjectQuery } from "../resources/jira-project.js";
import { zendeskTicketQueryProblems } from "../resources/zendesk-ticket.js";
import { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider } from "./agent-key.js";
import { powerValueProblems, resolveModelPower, resolveEffortPower, AGENT_EFFORTS, type AgentEffort } from "../resources/power-scale.js";

export { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider };
/** Agent harnesses Drovr can launch. */
export const AGENT_HARNESSES = ["claude", "codex", "agy"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];
/**
 * FACTORY-75: moved to src/resources/power-scale.ts (that module's own top
 * comment explains why — it needs this type for its shared effort table,
 * and must not import it back from here) and re-exported here unchanged
 * for every existing importer of `rules.js`.
 */
export { AGENT_EFFORTS, type AgentEffort };
/**
 * FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42) — the same five
 * permission-mode values `SessionDefinition.permissionMode` accepts
 * (`SESSION_PERMISSION_MODES`, src/resources/session-definition.ts), kept as
 * an INDEPENDENT copy here rather than imported: that module already imports
 * `ExecutionMode`/`AccountPolicy`/`AgentRole`/`McpServerBinding` FROM this
 * file, so importing its `SESSION_PERMISSION_MODES` back would cycle this
 * file with it. FACTORY-577: no longer Claude-only — `agentLaunchConfig`
 * (src/agents/argv.ts) reads `spec.permissionMode` on its Codex branch too
 * now (mapped onto `bypassApprovalsAndSandbox`), same as `permissionMode`'s
 * own doc comment there. Still silently never forwarded to an Agy launch
 * (that branch never reads it at all). Unlike `SessionDefinition`, a `Rule`
 * has no single fixed `vendor` to validate this against — `agentPreferences`
 * is a ranked FALLBACK list, not one committed choice, and the harness an
 * individual agent actually gets is a runtime decision (`src/agents/herd.ts`)
 * no validator here can see — so there is deliberately no Codex-vendor
 * rejection for this field: a rule that falls back to Codex now gets the
 * SAME explicit mapping a Claude launch gets (no longer a silent no-op),
 * and a rule that falls back to Agy still gets the same silent no-op an
 * absent `permissionMode` always gave that branch. `Rule.lizardMode` below
 * is a DIFFERENT case as of FACTORY-108 — see its own doc comment.
 */
export const RULE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "auto"] as const;
export type RulePermissionMode = (typeof RULE_PERMISSION_MODES)[number];

/**
 * How many agents a rule runs (BUTCHR-392/BUTCHR-397; see `docs/execution-modes.md`).
 * `swarm` (today's only behaviour, and the default): one agent per matching
 * resource, none at zero matches. `singleton`: one agent for the rule's whole
 * matching workload; it stops at zero matches and starts again when matches
 * return. `persistent`: one agent even at zero matches; only an explicit
 * freeze (`enabled: false`) stops it. This task adds and validates the field
 * alone — reconciling `singleton`/`persistent` (spawning/stopping the one
 * agent, delivering it scope-wide events) is BUTCHR-398.
 */
export const EXECUTION_MODES = ["swarm", "singleton", "persistent"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Rocket.Chat account lifecycle for a rule's agent(s) (BUTCHR-392/BUTCHR-397),
 * independent of `execution`. `none` (the default) is today's behaviour
 * exactly — no account is created or managed. `temporary`/`permanent` are
 * accepted and plumbed onto `Rule` by this task only; the account lifecycle
 * itself (creating, attaching, tearing down a Rocket.Chat account) is a later
 * story (S4) and NOT implemented here.
 */
export const ACCOUNT_POLICIES = ["none", "temporary", "permanent"] as const;
export type AccountPolicy = (typeof ACCOUNT_POLICIES)[number];

/**
 * Fleet capacity role (BUTCHR-391 epic decision, 2026-09-25T00:25Z, folded
 * into BUTCHR-398): independent of `execution`/`account`. `worker` (the
 * default) counts toward `BUTCHR_MAX_AGENTS` and is subject to admission
 * withholding exactly as every agent is today. `sentinel` opts a rule's
 * agent(s) OUT of the cap entirely — never withheld, never counted toward
 * residency — for long-lived agents (e.g. persistent directors) that must
 * never be starved by, or compete for, ordinary worker capacity. Applies
 * per-agent: a swarm rule's every per-resource agent is a sentinel, or a
 * singleton/persistent rule's one query-level agent is. See
 * src/agents/admission.ts for how residency/admission honour this.
 */
export const AGENT_ROLES = ["worker", "sentinel"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * FACTORY-75: `modelPower`/`effortPower` are the SAME 0-100 two-axis
 * mechanism `SessionDefinition` uses (src/resources/power-scale.ts's own
 * top comment) resolved to `model`/`effort` at RULE-PARSE time (`loadRules`,
 * once at daemon startup) — by the time any of this codebase's existing
 * `agentPreferences`-consuming code (every `specFor*` in src/rules/*-type.ts,
 * `src/agents/herd.ts`'s `prepare()`) ever looks at a preference, `model`/
 * `effort` are already filled in exactly as if written by hand, so NONE of
 * that code needed to change. Named `modelPower`, never `capability` (the
 * ticket's own suggestion) — `capability` already names an unrelated
 * concept in this codebase (src/resources/capabilities.ts's per-provider
 * capability declarations) and reusing the word here would read as related
 * when it isn't. Named `effortPower`, never reusing `effort`'s own name —
 * `effort` is this field's pre-existing explicit override (a literal
 * `AgentEffort` string), and the two coexisting under one name would be
 * ambiguous; setting BOTH `effort` and `effortPower` (or both `model` and
 * `modelPower`) on the same preference is rejected at load time
 * (`parsePreferences` below) rather than silently letting one win.
 * Absent (every rule before this ticket) means today's behaviour exactly —
 * an explicit `model`/`effort`, or neither, same as always.
 */
export interface AgentPreference { harness: AgentHarness; model?: string; effort?: AgentEffort; modelPower?: number; effortPower?: number }

/** MCP server binding shapes a rule/definition can bind to, beyond butchr's own. Only `http` today. */
export const MCP_SERVER_BINDING_TYPES = ["http"] as const;
export type McpServerBindingType = (typeof MCP_SERVER_BINDING_TYPES)[number];

/** The name every launch already reserves for butchr's own MCP server; no binding may reuse it. */
export const RESERVED_MCP_SERVER_NAME = "butchr";

/**
 * One additional MCP server a rule's agent(s) (or a managed-session
 * definition's agent, BUTCHR-408) may connect to, beyond butchr's own
 * (BUTCHR-411/CNDLX-45; the type was ported to main's session-definition
 * work from this story's BUTCHR-395 branch, PR #387 merge commit 5520722,
 * per the epic's sequencing decision on BUTCHR-408 — S4 had not landed this
 * on `main` yet when the session-definition work needed it, so that was
 * source material copied verbatim, not a competing shape; this sync is
 * where S4's own `Rule.mcpServers` lands on `main` and the two uses
 * converge on this one type). `channel: true` means Claude also receives
 * this server's push notifications — one more
 * `--dangerously-load-development-channels=server:<name>` entry, the exact
 * mechanism `server:butchr` already relies on (src/agents/argv.ts) — so
 * event-driven delivery from a non-Rocket.Chat MCP server (e.g. a MUD
 * bridge) needs no polling substitute. `channel: false` still reaches
 * `mcp.json`/the Codex `mcpServers` config (tools work) but is never added
 * to the channel flag.
 *
 * `headersEnvVar`, not `headers`: header VALUES (often bearer tokens) are
 * never written into a rules file or a managed-session definition file
 * itself — only the NAME of an env var on THIS DAEMON's own process that
 * holds a JSON object of header values, resolved at launch time
 * (`resolveMcpServerHeaders`, src/agents/workspace.ts). A binding with no
 * `headersEnvVar`, or one naming an unset/malformed var, simply connects
 * with no extra headers (logged once, value never logged). A resolved
 * header value is written ONLY into a Claude workspace's `mcp.json`
 * (permission-tightened when it carries one — see that function's own doc
 * comment) — NEVER into Codex argv, which is a real process command line
 * other local users can read (review finding, PR #387): `boundCodexServers`
 * (src/agents/argv.ts) never resolves headers at all, so a Codex agent gets
 * a bound server's tools with no extra headers, regardless of
 * `headersEnvVar` (BUTCHR-408's own manifest doc calls this out for its
 * Codex example definitions too).
 *
 * Deliberately independent of `Rule.account`/`Rule.execution`: a binding (and
 * its `channel` flag) is wired into launch argv from this field alone, never
 * from account policy, so an `account: "none"` rule (no Rocket.Chat account
 * — e.g. Candlestix's MUD players) still gets full event-driven channel
 * delivery for a bound server.
 *
 * `accountHeader`, not a second binding mechanism (BUTCHR-412, BUTCHR-391
 * comment 24007): the corrected Rocket.Chat credential design has an agent's
 * MCP binding carry only its OWN (non-secret) account name, in a header —
 * `x-rocketr-account` for rocketr — which `headersEnvVar` above cannot
 * express: that resolves ONE static value per RULE from the daemon's own
 * env, while an account name is per-AGENT (this rule's every agent gets a
 * DIFFERENT one) and never secret to begin with (unlike a `headersEnvVar`
 * value, which is deliberately kept out of Codex argv entirely — see that
 * field's own doc comment; `accountHeader`'s value has no such restriction,
 * and BUTCHR-413 does resolve it for Codex, via `resolveAccountHeader`
 * reused directly in `boundCodexServers`, src/agents/argv.ts — the small,
 * explicit extension that review's finding 1 needed, proven by a test that
 * a Codex agent's own bound `rocketr` server carries its account name with
 * no secret ever alongside it). Set to the literal header NAME (e.g.
 * `"x-rocketr-account"`); the VALUE is resolved at launch time from
 * `SpawnSpec.rocketchatAccount` (`resolveAccountHeader`, `src/agents/workspace.ts`)
 * — set only by `../agents/account-lifecycle.ts`'s `ensure`, after
 * `ensureAccount` actually provisioned this agent's account, never written
 * into a rules file or a managed-session definition itself. A binding with
 * `accountHeader` set but no `spec.rocketchatAccount` (this rule's `account`
 * policy is `"none"`, or `ensureAccount` hasn't run for this spec) simply
 * omits the header — same "absent means no extra header" discipline
 * `headersEnvVar` already has. Combines with `headersEnvVar` on the SAME
 * binding if both are set (rare, but not forbidden): the two are resolved
 * independently and merged.
 */
export interface McpServerBinding {
  name: string;
  type: McpServerBindingType;
  url: string;
  headersEnvVar?: string;
  accountHeader?: string;
  channel: boolean;
}

/**
 * Relationships name other rules; how a link is realised in the resource
 * system (a Jira issue link, a backlink field) is the provider adapter's
 * concern, not configuration.
 */
export interface RuleRelationships {
  /** The rule a child created by this rule's agent is meant to match — "what a child is". One child rule per rule. */
  childRule?: string;
  /**
   * Rules whose agents may open an inward connection to this rule's agents. Static ids only; no patterns yet.
   * Same-provider for `jira-work` (over Jira `Relates` links). A `jira-idea` rule may list only
   * `github-issue` rules (over the idea's Jira remote links to those issues); it takes no `childRule`.
   */
  inwardConnectionRules?: string[];
}

export interface Rule {
  /** Stable id; part of every agent key this rule produces. Editing anything else keeps agent identity. */
  id: string;
  /** Disabled rules stay configured (and keep their identity) but should run no agents. Defaults to true. */
  enabled: boolean;
  resourceProvider: ResourceProvider;
  /**
   * Provider-native query selecting matching resources: JQL for `jira-work`
   * (proven work items only) and `jira-idea` (proven Product Discovery ideas
   * only — see src/resources/jira-idea.ts); GitHub issue search syntax for
   * `github-issue` (scoped to `BUTCHR_GITHUB_ORGS`, never pull requests — see
   * src/resources/github-issue.ts); GitHub pull-request search syntax for
   * `github-pr` (same org scoping, never plain issues — see
   * src/resources/github-pr.ts); Zendesk search syntax for `zendesk-ticket`
   * (tickets only, in `ZENDESK_SUBDOMAIN` — see src/resources/zendesk-ticket.ts);
   * a JSON object (not JQL) for `jira-project` — `{ leadAccountId?, keys?,
   * query? }`, see `parseProjectQuery` (src/resources/jira-project.ts); a
   * small JSON object for `filesystem` (root, kind, name pattern, recursion
   * depth, an optional content/metadata predicate — see
   * src/resources/filesystem-query.ts and docs/filesystem.md for the syntax
   * decision).
   */
  query: string;
  /** Brief the agent is given; opaque to validation beyond being non-empty. */
  brief: string;
  /** How many agents this rule runs. Defaults to `"swarm"` (today's behaviour) when absent from the file. */
  execution: ExecutionMode;
  /** Rocket.Chat account lifecycle, independent of `execution`. Defaults to `"none"` (today's behaviour, exactly) when absent from the file. */
  account: AccountPolicy;
  /** Fleet capacity role, independent of `execution`/`account`. Defaults to `"worker"` (today's behaviour, exactly) when absent from the file. */
  role: AgentRole;
  /** Ranked, most preferred first. Absent means "use Butchr's global agent config". */
  agentPreferences?: AgentPreference[];
  relationships?: RuleRelationships;
  /** Additional MCP servers this rule's agent(s) may connect to, beyond butchr's own (BUTCHR-411). Absent means none — today's behaviour exactly. */
  mcpServers?: McpServerBinding[];
  /** Operator-owned MCP config path (`jira-project` rules only); `{{KEY}}` expands to the resource key. Absolute path required. */
  mcpConfigFile?: string;
  /**
   * BUTCHR-429 (epic BUTCHR-421, story 1/4): four additive, independently
   * optional knobs for "linked-change eventing" — a change to anything
   * LINKED to this rule's resources (a Jira issue link, parent Epic, remote
   * link, Confluence page, GitHub issue/PR, or general webpage) becoming a
   * turn-causing update, same as a change to the resource itself. Absent
   * means exactly today's behaviour: this story's own link DISCOVERY still
   * runs and logs (`[linked-discovery]`, src/jira-watch/linked-discovery-log.ts)
   * regardless of these knobs — it is a cost-free pure parse of data a
   * rule's poll already fetched — but nothing downstream of discovery exists
   * yet (that is stories 2/3), so no knob here changes any agent's behaviour
   * in this story. Kept as four independently optional fields, mirroring
   * `agentPreferences`/`relationships` above rather than `execution`/
   * `account`/`role`'s always-defaulted style, because "absent" and "false"
   * are the same no-op here — there is no live default value to normalise
   * onto every rule for a mechanism that does not run yet.
   */
  /** Opt in to linked-change eventing for this rule's agents. Absent/false: today's behaviour, exactly (see this field's own group comment above). Reserved for stories 2/3 to actually gate on; this story validates and plumbs it only. */
  linkedEventing?: boolean;
  /** Poll cadence (milliseconds) for the non-Jira link pollers (Confluence/GitHub/webpage) stories 2/3 add. Reserved: typed and validated here, consulted by no code in this story. */
  linkedPollIntervalMs?: number;
  /** Hard cap on linked items discovered/watched per resource; the excess is logged as skipped, never silently truncated — see `capLinkedItems` (src/resources/linked-discovery.ts), which this story's own discovery logging already honours. BUTCHR-471: for a rule with `linkedEventing: true`, absent no longer means uncapped — `runTick` (src/jira-watch/linked-eventing.ts) falls back to `DEFAULT_MAX_LINKED_ITEMS` (25) via `effectiveMaxLinkedItems`; an explicit value here always wins over that default, in both directions. */
  maxLinkedItems?: number;
  /** Sliding-window rate cap (turns/hour) for linked-change notifications, story 2's own per-agent budget. BUTCHR-471: for a rule with `linkedEventing: true`, absent no longer means uncapped — `runTick` (src/jira-watch/linked-eventing.ts) falls back to `DEFAULT_MAX_LINKED_TURNS_PER_HOUR` (2) via `effectiveMaxLinkedTurnsPerHour`; an explicit value here always wins over that default, in both directions. */
  maxLinkedTurnsPerHour?: number;
  /**
   * BUTCHR-436 (epic BUTCHR-421, story 2/4): opt in to fetching this rule's
   * matched resources' Jira REMOTE links as an additional linked-Jira-item
   * source, on top of issuelinks/parent/description (all free — they ride
   * the existing search fields). Unlike those, a remote link costs one
   * genuinely separate API call per resource
   * (`AtlassianClient#remoteLinks`), so it is gated behind this own knob
   * rather than folded into `linkedEventing` — a resource whose rule leaves
   * this absent/false makes ZERO remote-link calls. Only meaningful when
   * `linkedEventing` is also true; absent/false is today's behaviour
   * exactly (no remote-link fetch, same as before this field existed).
   */
  linkedRemoteLinks?: boolean;
  /**
   * BUTCHR-437 (epic BUTCHR-421, story 3/4): opt in to LIVE POLLING of
   * Confluence / GitHub-issue / GitHub-PR / webpage links found via
   * DESCRIPTION-TEXT PARSING (`descriptionItems`, src/resources/linked-discovery.ts)
   * — as opposed to a Jira remote link, which this knob does not gate (a
   * non-Jira remote link's live polling is out of scope for this story; see
   * `jiraKindLinkedItems`'s own doc comment, src/jira-watch/linked-eventing.ts).
   * Absent/false: today's behaviour exactly — `linkedEventing` alone still
   * enables Jira-kind polling, but none of these three pollers ever run, even
   * for a resource whose description names a Confluence page or GitHub
   * issue/PR. Only meaningful when `linkedEventing` is also true; mirrors
   * `linkedRemoteLinks`'s own independently-optional, cost-gated shape (each
   * of the three pollers this knob gates costs a genuinely separate network
   * call per distinct linked target per tick, never free the way `issuelinks`/
   * `parent`/description-derived Jira keys already are).
   */
  linkedDescriptionLinks?: boolean;
  /**
   * FACTORY-87 — the permission mode for agents THIS rule launches,
   * forwarded to `SpawnSpec.permissionMode` by every `specFor*` builder
   * (`specForMatch`/`specForRuleQuery`, `specForProject`,
   * `specForGithubIssue*`, `specForGithubPr*`, `specForFilesystem*`).
   * Originally Claude's own `--permission-mode` only; FACTORY-577: also
   * reaches a Codex-resolved launch now (mapped onto
   * `bypassApprovalsAndSandbox` — see `RULE_PERMISSION_MODES`'s own doc
   * comment above and `agentLaunchConfig`'s Codex branch, src/agents/argv.ts).
   * `src/agents/workspace.ts`'s persist-at-spawn/read-back stale-argv pair
   * (FACTORY-43) already reads `spec.permissionMode` generically for every
   * provider, not just managed sessions, so no new wiring is needed there —
   * only threading this field into each builder's own `SpawnSpec` output.
   * Absent means butchr's own default applies: `acceptEdits`
   * (`DEFAULT_PERMISSION_MODE`, `agentLaunchConfig`, src/agents/argv.ts,
   * since FACTORY-138 — previously Drovr's own `bypassPermissions` fallback
   * applied instead) — INCLUDING for a `jira-project` rule, whose own
   * unconditional `permissionMode: "auto"` default there is set BEFORE
   * `spec.permissionMode`'s spread (but AFTER butchr's own default) and so
   * is overridden by this field only when present. See `lizardMode` immediately below: the two fields are
   * independent (either may be set without the other), but pairing this with
   * `"default"` and `lizardMode: true` is the combination FACTORY-76 exists
   * for. See `RULE_PERMISSION_MODES`'s own doc comment for why there is no
   * Codex-vendor validation rejection here, unlike `SessionDefinition`'s.
   */
  permissionMode?: RulePermissionMode;
  /**
   * FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42's
   * `SessionDefinition.lizardMode`) — opts every agent THIS rule launches
   * into the daemon's standalone permission-answer timer
   * (`src/agents/permission-answer-loop.ts`, wired in `src/daemon/index.ts`):
   * drovr's `autoAnswerPermissions`/(FACTORY-108) `autoAnswerCodexApprovals`
   * answer an unambiguous tool-permission dialog on that agent's pane — see
   * that module's own doc comment / `docs/permission-answer-loop.md` for
   * exactly which option each presses and how it is logged, deliberately not
   * restated here since that is drovr's own answering policy, not this
   * field's concern (and is a moving target — FACTORY-93/FACTORY-67/
   * FACTORY-108/FACTORY-138) — originally built so a rule kept in
   * `permissionMode: "default"` was never left frozen on that dialog for
   * hours. FACTORY-138 (operator decision, FACTORY-67 director comment
   * 2026-09-26 22:24Z): butchr's own launch default is now `permissionMode:
   * "acceptEdits"` + this field eligible together — an accept-edits agent
   * still gets Bash/MCP tool-permission prompts, so it needs the same
   * unattended-clearing this field always provided for manual mode. Absent
   * now means ELIGIBLE FOR SCANNING (a rule that IS found and never sets this
   * field is scanned/touched by that timer, regardless of vendor); only an
   * EXPLICIT `false` opts a rule's panes out of scanning — that
   * absent-vs-false distinction is unchanged, only which one means "on" has
   * flipped. The timer's own scanning-eligibility gate is resolved live from
   * the loaded `rules` list (`ruleLizardModeOf`, an exported pure function in
   * `src/agents/permission-answer-loop.ts` — `src/daemon/index.ts` just binds
   * it to its own live state) as `rule.lizardMode !== false`, regardless of
   * vendor — unchanged by FACTORY-108.
   *
   * FACTORY-108: unlike scanning eligibility just described, this field is
   * ALSO forwarded onto `SpawnSpec.lizardMode` by every `specFor*` builder
   * (the same ones `permissionMode` threads through) — but there ONLY on an
   * EXPLICIT `true` (`rule.lizardMode ? { lizardMode: true } : {}`), never
   * merely-absent — so a Codex-resolved launch (`agentLaunchConfig`'s Codex
   * branch, src/agents/argv.ts) can read it and drop
   * `--dangerously-bypass-approvals-and-sandbox` only when a rule opted in
   * explicitly, and only when `permissionMode` above is itself absent —
   * FACTORY-577: `permissionMode`, when set, now ALSO reaches a Codex
   * launch (mapped onto `bypassApprovalsAndSandbox`, same as it always has
   * for Claude's own launch mode — see that field's own doc comment above)
   * and wins over this field, in both directions. See `SpawnSpec.lizardMode`'s
   * own doc comment (src/agents/workspace.ts) for the full contract,
   * including the FACTORY-43-style persist-at-spawn/read-back stale-argv
   * pair this now rides generically (nothing rule-specific was added for
   * it). A Claude- or Agy-resolved launch still ignores THIS field
   * completely (neither branch of `agentLaunchConfig` reads
   * `spec.lizardMode`), so the scanning-eligibility paragraph above remains
   * the whole story for those two vendors — only a Codex fallback is new
   * territory.
   *
   * **Deliberate rule-side asymmetry (story decision, FACTORY-106/FACTORY-324):**
   * a rule-launched Codex agent with `lizardMode` merely ABSENT is "eligible"
   * for scanning per `ruleLizardModeOf` above, but is still launched WITH the
   * bypass flag (launch keys on explicit `true` only, per the paragraph
   * above) — so `autoAnswerCodexApprovals` scans its pane every tick and
   * finds nothing to press, a harmless no-op, not a functional gap: an agent
   * launched with the bypass flag never shows the approval dialog this
   * mechanism answers in the first place. This mirrors
   * `SessionDefinition.lizardMode`'s own resolution (absent = ineligible for
   * a `vendor: "codex"` definition, explicit `true` = eligible AND launched
   * without the bypass flag, explicit `false` = ineligible — see that
   * field's own doc comment) in outcome for the codex-launch decision, but
   * NOT in the scanning-eligibility default, which stays `!== false` here
   * unconditionally rather than gaining a vendor check — changing that
   * default was judged unnecessary risk (it would silently claim coverage
   * nobody canaried) for a mismatch that costs nothing beyond one wasted
   * scan per tick. See
   * `RULE_PERMISSION_MODES`'s own doc comment for why there is no
   * Codex-vendor validation rejection here, unlike `SessionDefinition`'s
   * `strictMcpConfig`.
   * FACTORY-87 wires this (and `permissionMode` above) for exactly the four
   * rule kinds FACTORY-76 scopes — `jira-work`/`jira-project`/`github-issue`/
   * `github-pr`/`filesystem` (every `specFor*` builder forwards
   * `permissionMode`; `ruleLizardModeOf` covers every rule-engine agent id).
   * Both fields validate for `jira-idea`/`zendesk-ticket` rules too — same
   * "every provider accepts every value" house style `execution`/`account`/
   * `role` already use above — but neither is wired into
   * `specForJiraIdea`/`specForZendeskTicket` yet, so setting them on one of
   * those two rule kinds is accepted at load and silently has no effect: a
   * deliberate, documented scope boundary, not an oversight.
   */
  lizardMode?: boolean;
}

const RULE_FIELDS = new Set([
  "id", "enabled", "resourceProvider", "query", "brief", "execution", "account", "role", "agentPreferences", "relationships", "mcpServers", "mcpConfigFile",
  "linkedEventing", "linkedPollIntervalMs", "maxLinkedItems", "maxLinkedTurnsPerHour", "linkedRemoteLinks", "linkedDescriptionLinks",
  "permissionMode", "lizardMode",
]);
const PREFERENCE_FIELDS = new Set(["harness", "model", "effort", "modelPower", "effortPower"]);
const RELATIONSHIP_FIELDS = new Set(["childRule", "inwardConnectionRules"]);
const MCP_SERVER_BINDING_FIELDS = new Set(["name", "type", "url", "headersEnvVar", "accountHeader", "channel"]);
/** Same shape `DisabledMcpServer.name` validation uses (see workspace.ts's `workspaceIsolation`) — kept consistent so an MCP server name is never valid in one place and rejected in the other. */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** RFC 7230 `field-name` (token charset), lowercased-or-not — an HTTP header name. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === "string" && (options as readonly string[]).includes(v);
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const unknownFields = (raw: Record<string, unknown>, allowed: Set<string>, at: string, errors: string[]): void => {
  for (const k of Object.keys(raw)) if (!allowed.has(k)) errors.push(`${at} has unknown field "${k}"`);
};

function parsePreferences(raw: unknown, at: string, errors: string[]): AgentPreference[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push(`${at} must be a non-empty array`); return undefined; }
  const seen = new Set<string>();
  return raw.map((p, j) => {
    const pat = `${at}[${j}]`;
    if (!isObject(p)) { errors.push(`${pat} must be an object`); return undefined as never; }
    unknownFields(p, PREFERENCE_FIELDS, pat, errors);
    if (!oneOf(AGENT_HARNESSES, p.harness)) errors.push(`${pat}.harness must be one of ${AGENT_HARNESSES.join(", ")}`);
    if (p.model !== undefined && !nonEmpty(p.model)) errors.push(`${pat}.model must be a non-empty string`);
    if (p.effort !== undefined && !oneOf(AGENT_EFFORTS, p.effort)) errors.push(`${pat}.effort must be one of ${AGENT_EFFORTS.join(", ")}`);
    // FACTORY-75: modelPower/effortPower are the new 0-100 two-axis
    // mechanism (src/resources/power-scale.ts) — reject combining either
    // with its own explicit sibling (ambiguous precedence), and reject
    // either for "agy" (no power table exists for that harness — Drovr's
    // own AgyAgentLaunch has no effort concept at all, see agentLaunchConfig,
    // src/agents/argv.ts). Valid only when `p.harness` is already known-good
    // (claude/codex) AND the raw value itself passes `powerValueProblems` —
    // an invalid harness or an invalid power value both already pushed
    // their own error above/below, so resolution is skipped rather than
    // resolving against garbage input.
    const powerVendor: "claude" | "codex" | undefined = p.harness === "claude" || p.harness === "codex" ? p.harness : undefined;
    let modelPowerResolved: string | undefined;
    if (p.modelPower !== undefined) {
      if (p.model !== undefined) errors.push(`${pat} must not set both "model" and "modelPower"`);
      else if (p.harness === "agy") errors.push(`${pat}.modelPower is not supported for harness "agy" — agy has no model-power table`);
      else {
        const problems = powerValueProblems(p.modelPower, `${pat}.modelPower`);
        errors.push(...problems);
        if (problems.length === 0 && powerVendor) modelPowerResolved = resolveModelPower(powerVendor, p.modelPower as number);
      }
    }
    let effortPowerResolved: AgentEffort | undefined;
    if (p.effortPower !== undefined) {
      if (p.effort !== undefined) errors.push(`${pat} must not set both "effort" and "effortPower"`);
      else if (p.harness === "agy") errors.push(`${pat}.effortPower is not supported for harness "agy" — agy has no effort concept`);
      else {
        const problems = powerValueProblems(p.effortPower, `${pat}.effortPower`);
        errors.push(...problems);
        if (problems.length === 0) effortPowerResolved = resolveEffortPower(p.effortPower as number);
      }
    }
    const resolvedModel = typeof p.model === "string" ? p.model.trim() : modelPowerResolved;
    const resolvedEffort = p.effort !== undefined ? (p.effort as AgentEffort) : effortPowerResolved;
    const pref: AgentPreference = {
      harness: p.harness as AgentHarness,
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    };
    const identity = JSON.stringify([pref.harness, pref.model ?? null, pref.effort ?? null]);
    if (seen.has(identity)) errors.push(`${pat} repeats an earlier preference`);
    seen.add(identity);
    return pref;
  });
}

const isHttpUrl = (v: unknown): boolean => {
  if (typeof v !== "string" || v.trim() === "") return false;
  try { const u = new URL(v.trim()); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};

/**
 * Same validator shape as every other `parse*` helper in this file: collects
 * every problem into `errors` and returns `undefined` when any exist (the
 * caller never uses a partially-valid result). `at` names the field for
 * error text (e.g. `rules[2].mcpServers` or a session definition's own
 * `<path>.mcpServers`) — this function is deliberately caller/document
 * agnostic so both `Rule` and a session definition (BUTCHR-408) can share it
 * without either owning the other's shape.
 */
export function parseMcpServers(raw: unknown, at: string, errors: string[]): McpServerBinding[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push(`${at} must be a non-empty array`); return undefined; }
  const seen = new Set<string>();
  return raw.map((s, j) => {
    const pat = `${at}[${j}]`;
    if (!isObject(s)) { errors.push(`${pat} must be an object`); return undefined as never; }
    unknownFields(s, MCP_SERVER_BINDING_FIELDS, pat, errors);
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!nonEmpty(s.name) || !MCP_SERVER_NAME_RE.test(name)) errors.push(`${pat}.name must be a non-empty name of letters, digits, "_" or "-"`);
    else if (name === RESERVED_MCP_SERVER_NAME) errors.push(`${pat}.name "${RESERVED_MCP_SERVER_NAME}" is reserved for butchr's own server`);
    else if (seen.has(name)) errors.push(`${pat}.name "${name}" is a duplicate`);
    else seen.add(name);
    if (!oneOf(MCP_SERVER_BINDING_TYPES, s.type)) errors.push(`${pat}.type must be one of ${MCP_SERVER_BINDING_TYPES.join(", ")}`);
    if (!isHttpUrl(s.url)) errors.push(`${pat}.url must be an absolute http(s) URL`);
    const headersEnvVar = typeof s.headersEnvVar === "string" ? s.headersEnvVar.trim() : undefined;
    if (s.headersEnvVar !== undefined && (!nonEmpty(s.headersEnvVar) || !headersEnvVar || !ENV_VAR_NAME_RE.test(headersEnvVar))) errors.push(`${pat}.headersEnvVar must be an env var name (A-Z, 0-9, "_", not starting with a digit)`);
    const accountHeader = typeof s.accountHeader === "string" ? s.accountHeader.trim() : undefined;
    if (s.accountHeader !== undefined && (!nonEmpty(s.accountHeader) || !accountHeader || !HEADER_NAME_RE.test(accountHeader))) errors.push(`${pat}.accountHeader must be a valid HTTP header name`);
    if (typeof s.channel !== "boolean") errors.push(`${pat}.channel must be a boolean`);
    return {
      name, type: s.type as McpServerBindingType, url: typeof s.url === "string" ? s.url.trim() : "",
      ...(headersEnvVar ? { headersEnvVar } : {}),
      ...(accountHeader ? { accountHeader } : {}),
      channel: s.channel as boolean,
    };
  });
}

function parseRelationships(raw: unknown, at: string, errors: string[]): RuleRelationships | undefined {
  if (!isObject(raw)) { errors.push(`${at} must be an object`); return undefined; }
  unknownFields(raw, RELATIONSHIP_FIELDS, at, errors);
  const out: RuleRelationships = {};
  if (raw.childRule !== undefined) {
    if (typeof raw.childRule !== "string" || !isRuleId(raw.childRule)) errors.push(`${at}.childRule must be a rule id`);
    else out.childRule = raw.childRule;
  }
  if (raw.inwardConnectionRules !== undefined) {
    const ids = raw.inwardConnectionRules;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !isRuleId(x))) errors.push(`${at}.inwardConnectionRules must be an array of rule ids`);
    else if (new Set(ids).size !== ids.length) errors.push(`${at}.inwardConnectionRules has duplicates`);
    else out.inwardConnectionRules = ids as string[];
  }
  return out;
}

/**
 * Validates an already-parsed rules document: `{ "rules": [ ... ] }`.
 * Collects every problem before throwing so one edit fixes the whole file.
 * Unknown fields are rejected — a typo'd optional setting must not silently
 * fall back to the default. Relationship ids must name rules in the same
 * document (a disabled rule is a valid target).
 */
export function parseRules(doc: unknown, origin = "rules"): Rule[] {
  if (!isObject(doc) || !Array.isArray(doc.rules)) throw new Error(`${origin}: expected an object with a "rules" array`);
  const errors: string[] = [];
  const seen = new Set<string>();
  const rules: Rule[] = [];
  const refs: Array<{ at: string; id: string; provider: ResourceProvider }> = [];
  const providerOf = new Map<string, unknown>();
  doc.rules.forEach((raw, i) => {
    const at = `${origin}: rules[${i}]`;
    if (!isObject(raw)) { errors.push(`${at} must be an object`); return; }
    const before = errors.length;
    unknownFields(raw, RULE_FIELDS, at, errors);
    const { id, enabled, resourceProvider, query, brief, execution, account, role } = raw;
    if (typeof id !== "string" || !isRuleId(id)) errors.push(`${at}.id must be a lowercase slug (a-z, 0-9, single hyphens, max ${RULE_ID_MAX})`);
    else if (seen.has(id)) errors.push(`${at}.id "${id}" is a duplicate`);
    else { seen.add(id); providerOf.set(id, resourceProvider); }
    if (enabled !== undefined && typeof enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
    if (!oneOf(RESOURCE_PROVIDERS, resourceProvider)) errors.push(`${at}.resourceProvider must be one of ${RESOURCE_PROVIDERS.join(", ")}`);
    if (!nonEmpty(query)) errors.push(`${at}.query must be a non-empty string`);
    else if (resourceProvider === "github-issue") for (const p of githubIssueQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    else if (resourceProvider === "github-pr") for (const p of githubPrQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    else if (resourceProvider === "zendesk-ticket") for (const p of zendeskTicketQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    else if (resourceProvider === "jira-project") { try { parseProjectQuery(query as string); } catch (e) { errors.push(`${at}.query: ${String(e)}`); } }
    else if (resourceProvider === "filesystem") for (const p of filesystemQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    if (raw.mcpConfigFile !== undefined && (typeof raw.mcpConfigFile !== "string" || !isAbsolute(raw.mcpConfigFile))) errors.push(`${at}.mcpConfigFile must be an absolute path`);
    if (raw.mcpConfigFile !== undefined && resourceProvider !== "jira-project") errors.push(`${at}.mcpConfigFile is currently supported for jira-project only`);
    if (!nonEmpty(brief)) errors.push(`${at}.brief must be a non-empty string`);
    else { const problem = builtinBriefProblem(brief as string); if (problem) errors.push(`${at}.brief ${problem}`); }
    // `execution` and `account` are independent of each other (any of the 9 combinations
    // is valid) and, for now, of `resourceProvider` too: every provider accepts every mode
    // (see docs/execution-modes.md — BUTCHR-397 found no concrete provider-specific blocker).
    if (execution !== undefined && !oneOf(EXECUTION_MODES, execution)) errors.push(`${at}.execution must be one of ${EXECUTION_MODES.join(", ")}`);
    if (account !== undefined && !oneOf(ACCOUNT_POLICIES, account)) errors.push(`${at}.account must be one of ${ACCOUNT_POLICIES.join(", ")}`);
    // `role` (BUTCHR-398): independent of `execution`/`account` and of `resourceProvider` too — every provider accepts every role, same house style as the two fields above.
    if (role !== undefined && !oneOf(AGENT_ROLES, role)) errors.push(`${at}.role must be one of ${AGENT_ROLES.join(", ")}`);
    // BUTCHR-429: four independently optional linked-eventing knobs, same house style — independent of `resourceProvider`, `execution`, `account` and `role` alike, and of each other.
    const { linkedEventing, linkedPollIntervalMs, maxLinkedItems, maxLinkedTurnsPerHour, linkedRemoteLinks } = raw;
    if (linkedEventing !== undefined && typeof linkedEventing !== "boolean") errors.push(`${at}.linkedEventing must be a boolean`);
    if (linkedPollIntervalMs !== undefined && !isPositiveInt(linkedPollIntervalMs)) errors.push(`${at}.linkedPollIntervalMs must be a positive integer`);
    if (maxLinkedItems !== undefined && !isPositiveInt(maxLinkedItems)) errors.push(`${at}.maxLinkedItems must be a positive integer`);
    if (maxLinkedTurnsPerHour !== undefined && !isPositiveInt(maxLinkedTurnsPerHour)) errors.push(`${at}.maxLinkedTurnsPerHour must be a positive integer`);
    // BUTCHR-436: fifth linked-eventing knob, same independently-optional house style.
    if (linkedRemoteLinks !== undefined && typeof linkedRemoteLinks !== "boolean") errors.push(`${at}.linkedRemoteLinks must be a boolean`);
    // BUTCHR-437: sixth linked-eventing knob, same independently-optional house style.
    const { linkedDescriptionLinks } = raw;
    if (linkedDescriptionLinks !== undefined && typeof linkedDescriptionLinks !== "boolean") errors.push(`${at}.linkedDescriptionLinks must be a boolean`);
    // FACTORY-87: independent of resourceProvider/execution/account/role/linked-eventing, same
    // house style — see RULE_PERMISSION_MODES's own doc comment for why there is no Codex-vendor
    // rejection here, unlike SessionDefinition's own permissionMode/lizardMode fields.
    const { permissionMode, lizardMode } = raw;
    if (permissionMode !== undefined && !oneOf(RULE_PERMISSION_MODES, permissionMode)) errors.push(`${at}.permissionMode must be one of ${RULE_PERMISSION_MODES.join(", ")}`);
    if (lizardMode !== undefined && typeof lizardMode !== "boolean") errors.push(`${at}.lizardMode must be a boolean`);
    const agentPreferences = raw.agentPreferences === undefined ? undefined : parsePreferences(raw.agentPreferences, `${at}.agentPreferences`, errors);
    const relationships = raw.relationships === undefined ? undefined : parseRelationships(raw.relationships, `${at}.relationships`, errors);
    const mcpServers = raw.mcpServers === undefined ? undefined : parseMcpServers(raw.mcpServers, `${at}.mcpServers`, errors);
    if (errors.length !== before) return;
    if ((resourceProvider === "github-issue" || resourceProvider === "github-pr" || resourceProvider === "zendesk-ticket" || resourceProvider === "jira-project" || resourceProvider === "filesystem") && relationships) { errors.push(`${at}.relationships are not supported for ${resourceProvider} rules yet`); return; }
    if (resourceProvider === "jira-idea" && relationships?.childRule) { errors.push(`${at}.relationships.childRule is not supported for jira-idea rules; only inwardConnectionRules naming github-issue rules`); return; }
    if (relationships?.childRule) refs.push({ at: `${at}.relationships.childRule`, id: relationships.childRule, provider: resourceProvider as ResourceProvider });
    for (const r of relationships?.inwardConnectionRules ?? []) refs.push({ at: `${at}.relationships.inwardConnectionRules`, id: r, provider: resourceProvider as ResourceProvider });
    rules.push({
      id: id as string, enabled: enabled !== false, resourceProvider: resourceProvider as ResourceProvider,
      query: (query as string).trim(), brief: brief as string,
      execution: (execution as ExecutionMode | undefined) ?? "swarm",
      account: (account as AccountPolicy | undefined) ?? "none",
      role: (role as AgentRole | undefined) ?? "worker",
      ...(agentPreferences ? { agentPreferences } : {}),
      ...(relationships ? { relationships } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(typeof raw.mcpConfigFile === "string" ? { mcpConfigFile: raw.mcpConfigFile } : {}),
      ...(linkedEventing !== undefined ? { linkedEventing: linkedEventing as boolean } : {}),
      ...(linkedPollIntervalMs !== undefined ? { linkedPollIntervalMs: linkedPollIntervalMs as number } : {}),
      ...(maxLinkedItems !== undefined ? { maxLinkedItems: maxLinkedItems as number } : {}),
      ...(maxLinkedTurnsPerHour !== undefined ? { maxLinkedTurnsPerHour: maxLinkedTurnsPerHour as number } : {}),
      ...(linkedRemoteLinks !== undefined ? { linkedRemoteLinks: linkedRemoteLinks as boolean } : {}),
      ...(linkedDescriptionLinks !== undefined ? { linkedDescriptionLinks: linkedDescriptionLinks as boolean } : {}),
      ...(permissionMode !== undefined ? { permissionMode: permissionMode as RulePermissionMode } : {}),
      ...(lizardMode !== undefined ? { lizardMode: lizardMode as boolean } : {}),
    });
  });
  for (const { at, id, provider } of refs) {
    if (!seen.has(id)) errors.push(`${at} references unknown rule "${id}"`);
    else if (provider === "jira-idea") {
      if (providerOf.get(id) !== "github-issue") errors.push(`${at} references rule "${id}"; a jira-idea rule may only hear github-issue rules`);
    } else if (providerOf.get(id) !== provider) errors.push(`${at} references rule "${id}" of another resource provider; cross-provider relationships are not supported`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return rules;
}

export interface RulesEnv { [name: string]: string | undefined; BUTCHR_RULES_FILE?: string | undefined; XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined }

/** Where rules are read from: explicit override, else the XDG config dir. Empty values count as unset. */
export function rulesPath(env: RulesEnv = process.env): string {
  if (env.BUTCHR_RULES_FILE?.trim()) return env.BUTCHR_RULES_FILE.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "rules.json");
}

/** Reads the file's text, or `undefined` when it does not exist. Anything else (permissions, a directory) throws. */
export type ReadRulesFile = (path: string) => string | undefined;

const readIfExists: ReadRulesFile = (path) => {
  try { return readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
};

/**
 * Loads and validates rules. A missing default file is `origin: "missing"`
 * with zero rules — there is no fallback — so a caller can say plainly why
 * nothing is staffed. A missing explicit `BUTCHR_RULES_FILE` throws.
 */
export function loadRules(env: RulesEnv = process.env, read: ReadRulesFile = readIfExists): { path: string; origin: "file" | "missing"; rules: Rule[] } {
  const path = rulesPath(env);
  const text = read(path);
  if (text === undefined) {
    if (env.BUTCHR_RULES_FILE?.trim()) throw new Error(`BUTCHR_RULES_FILE ${path} does not exist; fix or unset it (only the default path may be absent)`);
    return { path, origin: "missing", rules: [] };
  }
  let doc: unknown;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error(`${path}: invalid JSON: ${(e as Error).message}`); }
  return { path, origin: "file", rules: parseRules(doc, path) };
}

/**
 * FACTORY-657: a live holder for the rules this daemon is currently
 * running. `loadRules` itself stays a one-shot, pure read — this is the
 * seam `src/daemon/index.ts` wires every consumer through instead of a
 * `let rules` it reassigns, so a reload (`setRules`, driven by SIGHUP, or
 * an in-process `reloadRules` call from FACTORY-663's future web write
 * path) takes effect on each provider's very next poll, with no daemon
 * restart.
 *
 * `getRules()` always returns the SAME array instance; `setRules` mutates
 * its CONTENTS in place (`splice`, never a reassignment) rather than
 * handing back a new array. That one property is load-bearing: most
 * consumers in this codebase read `deps.rules` live, per poll, straight off
 * the object they were constructed with (see e.g. `createRuleResourceType`'s
 * own `discovery.search`, src/rules/resource-type.ts) — if `setRules`
 * replaced the array instead of mutating it, every one of those
 * already-constructed closures would keep the OLD array forever, and this
 * holder would need to thread a getter *function* through every one of
 * them instead. Mutating in place means a plain `rules: getRules()` at
 * construction time is already reload-safe.
 */
export interface RulesHolder {
  getRules(): readonly Rule[];
  /** Replaces the held rules' CONTENTS in place — see this interface's own doc comment for why identity is preserved rather than reassigned. */
  setRules(next: readonly Rule[]): void;
}

export function createRulesHolder(initial: readonly Rule[]): RulesHolder {
  const live: Rule[] = [...initial];
  return {
    getRules: () => live,
    setRules: (next) => { live.splice(0, live.length, ...next); },
  };
}

/** One enabled jira-work rule's relationship field naming a rule id this daemon has no rule for. */
export interface UnresolvedRelationship {
  ruleId: string;
  field: "childRule" | "inwardConnectionRules";
  missingTarget: string;
}

/**
 * BUTCHR-405: enabled `jira-work` rules whose `relationships.childRule` or
 * `relationships.inwardConnectionRules` name a rule id absent from `rules`
 * itself. Purely existence-based — it does not ask whether the missing id is
 * staffed, observed, or enabled elsewhere (that is a different question, and
 * this check must keep working regardless of how or whether that question is
 * ever answered). Both the startup warning and the `/health` field call this
 * one function so they can never disagree.
 *
 * `parseRules` above already refuses to load a file where a relationship
 * targets an id missing from THAT SAME file, so this can never fire for
 * rules that came from a single `loadRules` call today. It stays a real,
 * independent check — not dead code — because it takes any `Rule[]`, not
 * only ones `parseRules` validated: a rule set assembled some other way
 * (built by hand in a test, or combined across sources) is exactly where a
 * dangling reference can reach here uncaught.
 *
 * `childRule` here is checked for existence only, same as
 * `inwardConnectionRules`, but the two differ in what a real gap would mean:
 * `inwardConnectionRules` still gates the live `Relates` routing edge
 * (`relatedForRules` in src/rules/resource-type.ts), so a dangling id there
 * is a real broken connection. `childRule` does not — PR #372 (BUTCHR-388,
 * already in main) dropped the `childRule` gate on `Implements` routing: a
 * boss now hears its implementer on the `Implements` link alone, across
 * daemons, with no rules-file wiring. So a dangling `childRule` id found
 * here would not break any live routing; the field is kept (parsed,
 * validated, and reported by this check) as a legacy/documentation-shaped
 * value only — "what a child created by this rule's agent is meant to
 * match" — with no effect on which agent hears what.
 */
export function unresolvedRelationships(rules: readonly Rule[]): UnresolvedRelationship[] {
  const ids = new Set(rules.map((r) => r.id));
  const out: UnresolvedRelationship[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.resourceProvider !== "jira-work") continue;
    const rel = rule.relationships;
    if (!rel) continue;
    if (rel.childRule !== undefined && !ids.has(rel.childRule)) out.push({ ruleId: rule.id, field: "childRule", missingTarget: rel.childRule });
    for (const target of rel.inwardConnectionRules ?? []) {
      if (!ids.has(target)) out.push({ ruleId: rule.id, field: "inwardConnectionRules", missingTarget: target });
    }
  }
  return out;
}

/** Startup log line for one `unresolvedRelationships` entry. */
export function formatUnresolvedRelationshipWarning(u: UnresolvedRelationship): string {
  return `WARNING: jira-work rule "${u.ruleId}" relationships.${u.field} names rule "${u.missingTarget}", which is not present in this daemon's own rules file; no edge is created — fix the id, or confirm "${u.missingTarget}" is staffed by a different daemon`;
}

export {
  decodeAgentKey, encodeAgentKey, isResourceId, type AgentKeyParts,
  decodeQueryAgentKey, encodeQueryAgentKey, type QueryAgentKeyParts,
  decodeAnyAgentKey, type AnyAgentKeyParts,
} from "./agent-key.js";
