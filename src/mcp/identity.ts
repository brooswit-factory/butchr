/**
 * Who is calling the butchr MCP server, per resource provider.
 *
 * A `jira-work` (or legacy) agent names its ticket with `x-issue`, and a rule
 * agent adds its agent key as `x-butchr-agent` — unchanged from before other
 * providers existed. A `github-issue`, `jira-idea`, `zendesk-ticket` or
 * `jira-project` agent sends ONLY `x-butchr-agent`: it carries no `x-issue`
 * for a Jira work tool to resolve (a GitHub issue, Zendesk ticket, or Jira
 * project is not a Jira work item, and an idea is not a work item), and a
 * connection claiming both such an agent key and an `x-issue` is refused
 * outright rather than guessed at.
 */
import { parseGithubIssueRef, type GithubIssueRef } from "../resources/github-issue-ref.js";
import { parseZendeskTicketRef, type ZendeskTicketRef } from "../resources/zendesk-ticket-ref.js";
import { decodeAnyAgentKey, type ResourceProvider } from "../rules/agent-key.js";

export type CallerIdentity =
  | { provider: "jira-work"; issue: string; agent?: string }
  | { provider: "github-issue"; agent: string; ruleId: string; resource: string; ref: GithubIssueRef }
  | { provider: "jira-project"; agent: string; ruleId: string; resource: string }
  | { provider: "jira-idea"; agent: string; ruleId: string; resource: string }
  | { provider: "zendesk-ticket"; agent: string; ruleId: string; resource: string; ref: ZendeskTicketRef }
  | { provider: "filesystem"; agent: string; ruleId: string; resource: string }
  | { provider: ResourceProvider; agent: string; ruleId: string; query: true };

/** Providers whose agents identify by agent key alone, never `x-issue`. */
export const KEY_ONLY_PROVIDERS: readonly ResourceProvider[] = ["github-issue", "jira-idea", "zendesk-ticket", "jira-project", "filesystem"];

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
  return issue ? { provider: "jira-work", issue, ...(agent ? { agent } : {}) } : null;
}
