/**
 * The agent key codec and the identity pieces it is built from — split out of
 * `./rules.ts` so the workspace/herd layer can name agents without loading
 * rule-file parsing. See `encodeAgentKey` for the format.
 */
import { isGithubIssueRef } from "../resources/github-issue-ref.js";
import { isIssueKey, isProjectId } from "../resources/id.js";
import { isZendeskTicketRef } from "../resources/zendesk-ticket-ref.js";

/**
 * One provider per resource TYPE, not per vendor: Jira work items, GitHub
 * issues, Jira Product Discovery ideas (the same Jira API as work items,
 * still a separate provider), Zendesk tickets, and free-form Jira project
 * resources (`jira-project`, one agent per project key rather than per
 * issue). Only providers with an adapter are listed.
 */
export const RESOURCE_PROVIDERS = ["jira-work", "github-issue", "jira-idea", "zendesk-ticket", "jira-project"] as const;
export type ResourceProvider = (typeof RESOURCE_PROVIDERS)[number];

/** Lowercase slug: starts alphanumeric, then alphanumerics or single hyphens. */
const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RULE_ID_MAX = 64;

export const isRuleId = (id: string): boolean => id.length <= RULE_ID_MAX && RULE_ID_RE.test(id);

const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === "string" && (options as readonly string[]).includes(v);

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

/**
 * Provider-native resource id shape. `jira-work`: an issue key (`PROJ-1`);
 * project keys are not resources there. `jira-project`: a Jira project key
 * (`PROJ`) IS the resource id — the one case where a bare project key is
 * valid. `github-issue`: a canonical `owner/repo#number` (lowercase owner
 * and repo). `jira-idea`: the Jira issue key of a Product Discovery idea
 * (`IDEAS-7`). `zendesk-ticket`: a canonical `<subdomain>#<id>` (`acme#123`).
 */
export function isResourceId(provider: ResourceProvider, id: string): boolean {
  switch (provider) {
    case "jira-work": return isIssueKey(id);
    case "jira-project": return isProjectId(id);
    case "github-issue": return isGithubIssueRef(id);
    case "jira-idea": return isIssueKey(id);
    case "zendesk-ticket": return isZendeskTicketRef(id);
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

/**
 * BUTCHR-397 — the identity of the ONE agent a `singleton`/`persistent` rule
 * runs for its whole matching workload, as opposed to `encodeAgentKey`'s one
 * key per matched resource. Derived from provider + rule id ALONE — never
 * from a matched resource — so it is stable across daemon restarts and rule
 * re-matches, exactly as the docs for `execution` in `./rules.ts` require.
 *
 * Reserved literal in the resource-id slot instead of a shorter key, so this
 * shares its `<resourceProvider>:<ruleId>:` prefix with that same rule's own
 * per-resource keys: `workspaceDirFor` (src/agents/workspace.ts) then places
 * the query-level workspace as a SIBLING inside
 * `<root>/<resourceProvider>/<ruleId>/`, one directory per matched resource
 * plus this one — never as their parent. A shorter `<provider>:<ruleId>` key
 * would instead land ON that shared parent directory, where
 * `buildWorkspace()` would write the query agent's own CLAUDE.md/brief.md
 * files into the very directory that is supposed to hold nothing but
 * per-resource subdirectories.
 *
 * `QUERY_AGENT_MARKER` can never collide with a real resource id: it starts
 * `@`, which no provider's native id format ever contains (Jira issue/idea
 * keys are `[A-Z][A-Z0-9_]*-[0-9]+`; a GitHub ref requires a `/` and a `#`; a
 * Zendesk ref requires a `#`) — asserted for every `RESOURCE_PROVIDERS`
 * member in `agent-key.test.ts`, not just claimed here. That is what makes
 * `decodeAgentKey` and `decodeQueryAgentKey` mutually exclusive: the former
 * rejects this literal via `isResourceId`, the latter rejects anything else.
 */
const QUERY_AGENT_MARKER = "@query";

/** A query-level agent key's parts: no `resourceId` — there is no single resource, by design (see `QUERY_AGENT_MARKER`). */
export interface QueryAgentKeyParts { resourceProvider: ResourceProvider; ruleId: string }

const joinQueryKey = (p: QueryAgentKeyParts): string => [p.resourceProvider, p.ruleId, QUERY_AGENT_MARKER].map(encodeURIComponent).join(SEP);

/**
 * Encodes a query-level agent key. The reserved marker is the literal
 * `@query`, but — same percent-encoding discipline as `encodeAgentKey` — the
 * `@` is escaped in the ACTUAL key string, so the real, produced form is
 * `%40query`, never a bare `@query` (BUTCHR-398 review: earlier docs/comments
 * in this codebase wrote the unescaped form, which an operator grepping a
 * real journal line or workspace path for it would never find):
 *
 *   <resourceProvider>:<ruleId>:%40query   e.g. jira-work:triage:%40query
 */
export function encodeQueryAgentKey(parts: QueryAgentKeyParts): string {
  if (!oneOf(RESOURCE_PROVIDERS, parts.resourceProvider)) throw new Error(`invalid resource provider: ${JSON.stringify(parts.resourceProvider)}`);
  if (!isRuleId(parts.ruleId)) throw new Error(`invalid rule id: ${JSON.stringify(parts.ruleId)}`);
  return joinQueryKey(parts);
}

/**
 * Inverse of `encodeQueryAgentKey`; `null` for anything it could not have
 * produced — including every key `decodeAgentKey` accepts (see
 * `QUERY_AGENT_MARKER`'s own comment for why the two never overlap).
 */
export function decodeQueryAgentKey(key: string): QueryAgentKeyParts | null {
  const raw = key.split(SEP);
  if (raw.length !== 3) return null;
  let decoded: string[];
  try { decoded = raw.map(decodeURIComponent); } catch { return null; }
  const [resourceProvider, ruleId, marker] = decoded as [string, string, string];
  if (!oneOf(RESOURCE_PROVIDERS, resourceProvider) || !isRuleId(ruleId) || marker !== QUERY_AGENT_MARKER) return null;
  const parts = { resourceProvider, ruleId };
  return joinQueryKey(parts) === key ? parts : null;
}

/** Either shape a `decodeAnyAgentKey` call can return, tagged so a caller need not re-derive which one it got. */
export type AnyAgentKeyParts = ({ kind: "resource" } & AgentKeyParts) | ({ kind: "query" } & QueryAgentKeyParts);

/**
 * Decodes either an `encodeAgentKey` (per-resource) or `encodeQueryAgentKey`
 * (query-level) value; `null` for anything neither could have produced. Use
 * this wherever a key must be recognised regardless of which shape it is —
 * workspace path mapping, ownership predicates, MCP identity, herd lookups —
 * so a query-level agent is never silently treated as legacy/unowned. Code
 * that only ever deals with one resource (e.g. "the Jira ticket this agent
 * works") should keep using `decodeAgentKey` directly: a query-level key
 * correctly fails it, since there is no single resource to name.
 */
export function decodeAnyAgentKey(key: string): AnyAgentKeyParts | null {
  const resource = decodeAgentKey(key);
  if (resource) return { kind: "resource", ...resource };
  const query = decodeQueryAgentKey(key);
  return query ? { kind: "query", ...query } : null;
}
