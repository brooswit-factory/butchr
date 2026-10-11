/**
 * Who is calling the butchr MCP server, per resource provider.
 *
 * A `jira-work` (or legacy) agent names its ticket with `x-issue`, and a rule
 * agent adds its agent key as `x-butchr-agent` — unchanged from before other
 * providers existed. A `github-issue`, `github-pr`, `jira-idea`,
 * `zendesk-ticket` or `jira-project` agent sends ONLY `x-butchr-agent`: it
 * carries no `x-issue` for a Jira work tool to resolve (a GitHub issue or
 * pull request, a Zendesk ticket, or a Jira project is not a Jira work item,
 * and an idea is not a work item), and a connection claiming both such an
 * agent key and an `x-issue` is refused outright rather than guessed at.
 */
import { parseGithubIssueRef, type GithubIssueRef } from "../resources/github-issue-ref.js";
import { parseGithubPrRef, type GithubPrRef } from "../resources/github-pr-ref.js";
import { parseZendeskTicketRef, type ZendeskTicketRef } from "../resources/zendesk-ticket-ref.js";
import { decodeAnyAgentKey, type ResourceProvider } from "../rules/agent-key.js";

export type CallerIdentity =
  | { provider: "jira-work"; issue: string; agent?: string }
  | { provider: "github-issue"; agent: string; ruleId: string; resource: string; ref: GithubIssueRef }
  | { provider: "github-pr"; agent: string; ruleId: string; resource: string; ref: GithubPrRef }
  | { provider: "jira-project"; agent: string; ruleId: string; resource: string }
  | { provider: "jira-idea"; agent: string; ruleId: string; resource: string }
  | { provider: "zendesk-ticket"; agent: string; ruleId: string; resource: string; ref: ZendeskTicketRef }
  | { provider: "filesystem"; agent: string; ruleId: string; resource: string }
  /**
   * FACTORY-998: the ONE provider that legitimately carries BOTH
   * `x-issue` (its own page's bare numeric id — what `get_my_confluence_page`/
   * `get_my_confluence_page_comments`, src/tools/defs.ts, read directly,
   * unchanged by this member's addition) AND `x-butchr-agent` (so events and
   * own-write echoes are scoped to the one rule agent, same as every other
   * rule-engine provider) — see `mcpIdentityHeaders`'s own doc comment
   * (src/agents/workspace.ts) for why `confluence-page` is not in
   * `KEY_ONLY_PROVIDERS` the way `filesystem`/`github-issue`/etc. are.
   * Without this member, such a caller fell through to the generic
   * `jira-work` case below — which would have let a `confluence-page` rule
   * agent pass `forJiraCallers`' gate (src/tools/github-issue.ts) untouched,
   * reaching every real Jira/Confluence write tool. `resource` is the
   * SAME bare page id as `x-issue`, carried here so a caller of this
   * identity never has to re-derive it from `x-issue` by hand.
   */
  | { provider: "confluence-page"; agent: string; ruleId: string; resource: string }
  | { provider: ResourceProvider; agent: string; ruleId: string; query: true };

/** Providers whose agents identify by agent key alone, never `x-issue`. */
export const KEY_ONLY_PROVIDERS: readonly ResourceProvider[] = ["github-issue", "github-pr", "jira-idea", "zendesk-ticket", "jira-project", "filesystem"];

/**
 * `decoded` is `decodeAnyAgentKey`'s result, so it can be a query-level key
 * (BUTCHR-397: a `singleton`/`persistent` rule's one agent, no single
 * resource). BUTCHR-398: such an agent identifies with `x-butchr-agent`
 * alone (`mcpIdentityHeaders`, src/agents/workspace.ts) — recognised here as
 * the `{ query: true }` variant of `CallerIdentity`, refused (`null`) only
 * if it ALSO carries `x-issue` (a query-level agent has no single ticket to
 * name one for — the same double-identity refusal every `KEY_ONLY_PROVIDERS`
 * branch below already applies), never crashing on a missing `resourceId`
 * and never silently misread as a per-resource caller.
 */
export function callerIdentity(headers: Readonly<Record<string, string | undefined>>): CallerIdentity | null {
  const issue = headers["x-issue"];
  const agent = headers["x-butchr-agent"];
  const anyDecoded = agent ? decodeAnyAgentKey(agent) : null;
  if (anyDecoded?.kind === "query") return issue ? null : { provider: anyDecoded.resourceProvider, agent: agent!, ruleId: anyDecoded.ruleId, query: true };
  const decoded = anyDecoded?.kind === "resource" ? anyDecoded : null;
  if (decoded?.resourceProvider === "github-issue") {
    const ref = parseGithubIssueRef(decoded.resourceId);
    return issue || !ref ? null : { provider: "github-issue", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId, ref };
  }
  if (decoded?.resourceProvider === "github-pr") {
    const ref = parseGithubPrRef(decoded.resourceId);
    return issue || !ref ? null : { provider: "github-pr", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId, ref };
  }
  if (decoded?.resourceProvider === "jira-project") {
    return issue ? null : { provider: "jira-project", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId };
  }
  if (decoded?.resourceProvider === "jira-idea") {
    return issue ? null : { provider: "jira-idea", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId };
  }
  if (decoded?.resourceProvider === "zendesk-ticket") {
    const ref = parseZendeskTicketRef(decoded.resourceId);
    return issue || !ref ? null : { provider: "zendesk-ticket", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId, ref };
  }
  if (decoded?.resourceProvider === "filesystem") {
    return issue ? null : { provider: "filesystem", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId };
  }
  // FACTORY-998: the one branch that REQUIRES `issue`, rather than refusing
  // its presence — see `CallerIdentity`'s own "confluence-page" member doc
  // comment above for why. `issue !== decoded.resourceId` (missing OR
  // mismatched) refuses defensively rather than ever trusting one over the
  // other.
  if (decoded?.resourceProvider === "confluence-page") {
    return issue === decoded.resourceId ? { provider: "confluence-page", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId } : null;
  }
  return issue ? { provider: "jira-work", issue, ...(agent ? { agent } : {}) } : null;
}
