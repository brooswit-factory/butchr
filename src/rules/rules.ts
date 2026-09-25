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
import { parseProjectQuery } from "../resources/jira-project.js";
import { zendeskTicketQueryProblems } from "../resources/zendesk-ticket.js";
import { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider } from "./agent-key.js";

export { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider };
/** Agent harnesses Drovr can launch. */
export const AGENT_HARNESSES = ["claude", "codex", "agy"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

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

export interface AgentPreference { harness: AgentHarness; model?: string; effort?: AgentEffort }

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
   * src/resources/github-issue.ts); Zendesk search syntax for `zendesk-ticket`
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
  /** Hard cap on linked items discovered/watched per resource; the excess is logged as skipped, never silently truncated — see `capLinkedItems` (src/resources/linked-discovery.ts), which this story's own discovery logging already honours. */
  maxLinkedItems?: number;
  /** Sliding-window rate cap (turns/hour) for linked-change notifications, story 2's own per-agent budget. Reserved: typed and validated here, consulted by no code in this story. */
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
}

const RULE_FIELDS = new Set([
  "id", "enabled", "resourceProvider", "query", "brief", "execution", "account", "role", "agentPreferences", "relationships", "mcpConfigFile",
  "linkedEventing", "linkedPollIntervalMs", "maxLinkedItems", "maxLinkedTurnsPerHour", "linkedRemoteLinks", "linkedDescriptionLinks",
]);
const PREFERENCE_FIELDS = new Set(["harness", "model", "effort"]);
const RELATIONSHIP_FIELDS = new Set(["childRule", "inwardConnectionRules"]);

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
    const pref: AgentPreference = {
      harness: p.harness as AgentHarness,
      ...(typeof p.model === "string" ? { model: p.model.trim() } : {}),
      ...(p.effort !== undefined ? { effort: p.effort as AgentEffort } : {}),
    };
    const identity = JSON.stringify([pref.harness, pref.model ?? null, pref.effort ?? null]);
    if (seen.has(identity)) errors.push(`${pat} repeats an earlier preference`);
    seen.add(identity);
    return pref;
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
    const agentPreferences = raw.agentPreferences === undefined ? undefined : parsePreferences(raw.agentPreferences, `${at}.agentPreferences`, errors);
    const relationships = raw.relationships === undefined ? undefined : parseRelationships(raw.relationships, `${at}.relationships`, errors);
    if (errors.length !== before) return;
    if ((resourceProvider === "github-issue" || resourceProvider === "zendesk-ticket" || resourceProvider === "jira-project" || resourceProvider === "filesystem") && relationships) { errors.push(`${at}.relationships are not supported for ${resourceProvider} rules yet`); return; }
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
      ...(typeof raw.mcpConfigFile === "string" ? { mcpConfigFile: raw.mcpConfigFile } : {}),
      ...(linkedEventing !== undefined ? { linkedEventing: linkedEventing as boolean } : {}),
      ...(linkedPollIntervalMs !== undefined ? { linkedPollIntervalMs: linkedPollIntervalMs as number } : {}),
      ...(maxLinkedItems !== undefined ? { maxLinkedItems: maxLinkedItems as number } : {}),
      ...(maxLinkedTurnsPerHour !== undefined ? { maxLinkedTurnsPerHour: maxLinkedTurnsPerHour as number } : {}),
      ...(linkedRemoteLinks !== undefined ? { linkedRemoteLinks: linkedRemoteLinks as boolean } : {}),
      ...(linkedDescriptionLinks !== undefined ? { linkedDescriptionLinks: linkedDescriptionLinks as boolean } : {}),
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
