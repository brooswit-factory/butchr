/**
 * The agent key codec and the identity pieces it is built from — split out of
 * `./rules.ts` so the workspace/herd layer can name agents without loading
 * rule-file parsing. See `encodeAgentKey` for the format.
 */
import { isGithubIssueRef } from "../resources/github-issue-ref.js";
import { isIssueKey } from "../resources/id.js";
import { isZendeskTicketRef } from "../resources/zendesk-ticket-ref.js";

/**
 * One provider per resource TYPE, not per vendor: Jira work items, GitHub
 * issues, Jira Product Discovery ideas (the same Jira API as work items,
 * still a separate provider) and Zendesk tickets. Only providers with an
 * adapter are listed.
 */
export const RESOURCE_PROVIDERS = ["jira-work", "github-issue", "jira-idea", "zendesk-ticket"] as const;
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
 * project keys are not resources. `github-issue`: a canonical
 * `owner/repo#number` (lowercase owner and repo). `jira-idea`: the Jira
 * issue key of a Product Discovery idea (`IDEAS-7`). `zendesk-ticket`: a
 * canonical `<subdomain>#<id>` (`acme#123`).
 */
export function isResourceId(provider: ResourceProvider, id: string): boolean {
  switch (provider) {
    case "jira-work": return isIssueKey(id);
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
