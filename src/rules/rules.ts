import { parseProjectQuery } from '../resources/jira-project.js';
import { isAbsolute } from 'node:path';
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
import { join } from "node:path";
import { githubIssueQueryProblems } from "../resources/github-issue.js";
import { zendeskTicketQueryProblems } from "../resources/zendesk-ticket.js";
import { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider } from "./agent-key.js";

export { isRuleId, RESOURCE_PROVIDERS, RULE_ID_MAX, type ResourceProvider };
/** Agent harnesses Drovr can launch. */
export const AGENT_HARNESSES = ["claude", "codex", "agy"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

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
   * (tickets only, in `ZENDESK_SUBDOMAIN` — see src/resources/zendesk-ticket.ts).
   */
  query: string;
  /** Brief the agent is given; opaque to validation beyond being non-empty. */
  brief: string;
  /** Ranked, most preferred first. Absent means "use Butchr's global agent config". */
  agentPreferences?: AgentPreference[];
  relationships?: RuleRelationships;
  /** Optional operator-owned MCP config path; {{KEY}} expands to the resource key. */
  mcpConfigFile?: string;
}

const RULE_FIELDS = new Set(["id", "enabled", "resourceProvider", "query", "brief", "agentPreferences", "relationships", "mcpConfigFile"]);
const PREFERENCE_FIELDS = new Set(["harness", "model", "effort"]);
const RELATIONSHIP_FIELDS = new Set(["childRule", "inwardConnectionRules"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === "string" && (options as readonly string[]).includes(v);
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
    const { id, enabled, resourceProvider, query, brief } = raw;
    if (typeof id !== "string" || !isRuleId(id)) errors.push(`${at}.id must be a lowercase slug (a-z, 0-9, single hyphens, max ${RULE_ID_MAX})`);
    else if (seen.has(id)) errors.push(`${at}.id "${id}" is a duplicate`);
    else { seen.add(id); providerOf.set(id, resourceProvider); }
    if (enabled !== undefined && typeof enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
    if (!oneOf(RESOURCE_PROVIDERS, resourceProvider)) errors.push(`${at}.resourceProvider must be one of ${RESOURCE_PROVIDERS.join(", ")}`);
    if (!nonEmpty(query)) errors.push(`${at}.query must be a non-empty string`);
    else if (resourceProvider === "github-issue") for (const p of githubIssueQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    else if (resourceProvider === "zendesk-ticket") for (const p of zendeskTicketQueryProblems(query)) errors.push(`${at}.query: ${p}`);
    if (resourceProvider === "jira-project" && nonEmpty(query)) { try { parseProjectQuery(query); } catch(e) { errors.push(`${at}.query: ${String(e)}`); } }
    if (raw.mcpConfigFile !== undefined && (typeof raw.mcpConfigFile !== "string" || !isAbsolute(raw.mcpConfigFile))) errors.push(`${at}.mcpConfigFile must be an absolute path`);
    if (raw.mcpConfigFile !== undefined && resourceProvider !== "jira-project") errors.push(`${at}.mcpConfigFile is currently supported for jira-project only`);
    if (!nonEmpty(brief)) errors.push(`${at}.brief must be a non-empty string`);
    const agentPreferences = raw.agentPreferences === undefined ? undefined : parsePreferences(raw.agentPreferences, `${at}.agentPreferences`, errors);
    const relationships = raw.relationships === undefined ? undefined : parseRelationships(raw.relationships, `${at}.relationships`, errors);
    if (errors.length !== before) return;
    if ((resourceProvider === "github-issue" || resourceProvider === "zendesk-ticket" || resourceProvider === "jira-project") && relationships) { errors.push(`${at}.relationships are not supported for ${resourceProvider} rules yet`); return; }
    if (resourceProvider === "jira-idea" && relationships?.childRule) { errors.push(`${at}.relationships.childRule is not supported for jira-idea rules; only inwardConnectionRules naming github-issue rules`); return; }
    if (relationships?.childRule) refs.push({ at: `${at}.relationships.childRule`, id: relationships.childRule, provider: resourceProvider as ResourceProvider });
    for (const r of relationships?.inwardConnectionRules ?? []) refs.push({ at: `${at}.relationships.inwardConnectionRules`, id: r, provider: resourceProvider as ResourceProvider });
    rules.push({
      id: id as string, enabled: enabled !== false, resourceProvider: resourceProvider as ResourceProvider,
      query: (query as string).trim(), brief: brief as string,
      ...(agentPreferences ? { agentPreferences } : {}),
      ...(relationships ? { relationships } : {}),
      ...(typeof raw.mcpConfigFile === "string" ? {mcpConfigFile:raw.mcpConfigFile} : {}),
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

export { decodeAgentKey, encodeAgentKey, isResourceId, type AgentKeyParts } from "./agent-key.js";
