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
 * PURE AND UNWIRED. Nothing in the daemon reads this module yet — loading
 * rules here changes no runtime behaviour. The only I/O is the injectable
 * `read` in `loadRules`, mirroring `loadConfig`'s `readFile` seam.
 *
 * Rules live in a JSON file OUTSIDE the repo: `BUTCHR_RULES_FILE` when set,
 * else `$XDG_CONFIG_HOME/butchr/rules.json`, else
 * `~/.config/butchr/rules.json`. When that file is absent the built-in
 * example rules (`./defaults.ts`) are used in memory; nothing is written.
 * A present file replaces the defaults entirely — it is never merged, so
 * deleting a rule from the file really deletes it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIssueKey } from "../resources/id.js";
import { DEFAULT_RULES_DOCUMENT } from "./defaults.js";

/**
 * One provider per resource TYPE, not per vendor: Jira work items today;
 * Product Discovery ideas, GitHub issues, Zendesk tickets would each be
 * their own provider later. Only providers with an adapter are listed.
 */
export const RESOURCE_PROVIDERS = ["jira-work"] as const;
export type ResourceProvider = (typeof RESOURCE_PROVIDERS)[number];
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
  /** Rules whose agents may open an inward connection to this rule's agents. Static ids only; no patterns yet. */
  inwardConnectionRules?: string[];
}

export interface Rule {
  /** Stable id; part of every agent key this rule produces. Editing anything else keeps agent identity. */
  id: string;
  /** Disabled rules stay configured (and keep their identity) but should run no agents. Defaults to true. */
  enabled: boolean;
  resourceProvider: ResourceProvider;
  /** Provider-native query selecting matching resources (JQL for `jira-work`). */
  query: string;
  /** Brief the agent is given; opaque to validation beyond being non-empty. */
  brief: string;
  /** Ranked, most preferred first. Absent means "use Butchr's global agent config". */
  agentPreferences?: AgentPreference[];
  relationships?: RuleRelationships;
}

/** Lowercase slug: starts alphanumeric, then alphanumerics or single hyphens. */
const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RULE_ID_MAX = 64;

export const isRuleId = (id: string): boolean => id.length <= RULE_ID_MAX && RULE_ID_RE.test(id);

const RULE_FIELDS = new Set(["id", "enabled", "resourceProvider", "query", "brief", "agentPreferences", "relationships"]);
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
  const refs: Array<{ at: string; id: string }> = [];
  doc.rules.forEach((raw, i) => {
    const at = `${origin}: rules[${i}]`;
    if (!isObject(raw)) { errors.push(`${at} must be an object`); return; }
    const before = errors.length;
    unknownFields(raw, RULE_FIELDS, at, errors);
    const { id, enabled, resourceProvider, query, brief } = raw;
    if (typeof id !== "string" || !isRuleId(id)) errors.push(`${at}.id must be a lowercase slug (a-z, 0-9, single hyphens, max ${RULE_ID_MAX})`);
    else if (seen.has(id)) errors.push(`${at}.id "${id}" is a duplicate`);
    else seen.add(id);
    if (enabled !== undefined && typeof enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
    if (!oneOf(RESOURCE_PROVIDERS, resourceProvider)) errors.push(`${at}.resourceProvider must be one of ${RESOURCE_PROVIDERS.join(", ")}`);
    if (!nonEmpty(query)) errors.push(`${at}.query must be a non-empty string`);
    if (!nonEmpty(brief)) errors.push(`${at}.brief must be a non-empty string`);
    const agentPreferences = raw.agentPreferences === undefined ? undefined : parsePreferences(raw.agentPreferences, `${at}.agentPreferences`, errors);
    const relationships = raw.relationships === undefined ? undefined : parseRelationships(raw.relationships, `${at}.relationships`, errors);
    if (errors.length !== before) return;
    if (relationships?.childRule) refs.push({ at: `${at}.relationships.childRule`, id: relationships.childRule });
    for (const r of relationships?.inwardConnectionRules ?? []) refs.push({ at: `${at}.relationships.inwardConnectionRules`, id: r });
    rules.push({
      id: id as string, enabled: enabled !== false, resourceProvider: resourceProvider as ResourceProvider,
      query: (query as string).trim(), brief: brief as string,
      ...(agentPreferences ? { agentPreferences } : {}),
      ...(relationships ? { relationships } : {}),
    });
  });
  for (const { at, id } of refs) if (!seen.has(id)) errors.push(`${at} references unknown rule "${id}"`);
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
 * Loads and validates rules. `origin` says whether they came from the user's
 * file or the in-memory built-in examples, so a caller can refuse to act on
 * defaults it was never told to use.
 */
export function loadRules(env: RulesEnv = process.env, read: ReadRulesFile = readIfExists): { path: string; origin: "file" | "defaults"; rules: Rule[] } {
  const path = rulesPath(env);
  const text = read(path);
  if (text === undefined) return { path, origin: "defaults", rules: parseRules(DEFAULT_RULES_DOCUMENT, "built-in default rules") };
  let doc: unknown;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error(`${path}: invalid JSON: ${(e as Error).message}`); }
  return { path, origin: "file", rules: parseRules(doc, path) };
}

/**
 * Agent keys. An agent is (resource provider, rule id, provider-native
 * resource id) — never the resource alone, since several rules may match it:
 *
 *   <resourceProvider>:<ruleId>:<resourceId>     e.g. jira-work:triage:BUTCHR-12
 *
 * Each component is `encodeURIComponent`-escaped, which always escapes `:`,
 * so the key splits back into exactly one tuple. Decoding also requires the
 * key to be in canonical encoding (re-encoding reproduces it), so no two
 * distinct strings decode to the same tuple either: the codec is a bijection
 * between valid tuples and valid keys. A bare issue key contains no `:` and
 * never decodes. Native ids are escaped rather than charset-restricted so a
 * future provider's ids (`owner/repo#12`) need no codec change.
 */
export interface AgentKeyParts { resourceProvider: ResourceProvider; ruleId: string; resourceId: string }

/** Provider-native resource id shape. `jira-work`: an issue key (`PROJ-1`); project keys are not resources. */
export function isResourceId(provider: ResourceProvider, id: string): boolean {
  switch (provider) {
    case "jira-work": return isIssueKey(id);
  }
}

const SEP = ":";
const joinKey = (p: AgentKeyParts): string => [p.resourceProvider, p.ruleId, p.resourceId].map(encodeURIComponent).join(SEP);

export function encodeAgentKey(parts: AgentKeyParts): string {
  if (!oneOf(RESOURCE_PROVIDERS, parts.resourceProvider)) throw new Error(`invalid resource provider: ${JSON.stringify(parts.resourceProvider)}`);
  if (!isRuleId(parts.ruleId)) throw new Error(`invalid rule id: ${JSON.stringify(parts.ruleId)}`);
  if (!isResourceId(parts.resourceProvider, parts.resourceId)) throw new Error(`invalid ${parts.resourceProvider} resource id: ${JSON.stringify(parts.resourceId)}`);
  return joinKey(parts);
}

/** Inverse of `encodeAgentKey`; `null` for anything it could not have produced. */
export function decodeAgentKey(key: string): AgentKeyParts | null {
  const raw = key.split(SEP);
  if (raw.length !== 3) return null;
  let decoded: string[];
  try { decoded = raw.map(decodeURIComponent); } catch { return null; }
  const [resourceProvider, ruleId, resourceId] = decoded as [string, string, string];
  if (!oneOf(RESOURCE_PROVIDERS, resourceProvider) || !isRuleId(ruleId) || !isResourceId(resourceProvider, resourceId)) return null;
  const parts = { resourceProvider, ruleId, resourceId };
  return joinKey(parts) === key ? parts : null;
}
