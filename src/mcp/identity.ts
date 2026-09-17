/**
 * Who is calling the butchr MCP server, per resource provider.
 *
 * A `jira-work` (or legacy) agent names its ticket with `x-issue`, and a rule
 * agent adds its agent key as `x-butchr-agent` — unchanged from before other
 * providers existed. A `github-issue` or `jira-idea` agent sends ONLY
 * `x-butchr-agent`: it carries no `x-issue` for a Jira work tool to resolve
 * (a GitHub issue is not a Jira key, and an idea is not a work item), and a
 * connection claiming both such an agent key and an `x-issue` is refused
 * outright rather than guessed at.
 */
import { parseGithubIssueRef, type GithubIssueRef } from "../resources/github-issue-ref.js";
import { decodeAgentKey, type ResourceProvider } from "../rules/agent-key.js";

export type CallerIdentity =
  | { provider: "jira-work"; issue: string; agent?: string }
  | { provider: "github-issue"; agent: string; ruleId: string; resource: string; ref: GithubIssueRef }
  | { provider: "jira-idea"; agent: string; ruleId: string; resource: string };

/** Providers whose agents identify by agent key alone, never `x-issue`. */
export const KEY_ONLY_PROVIDERS: readonly ResourceProvider[] = ["github-issue", "jira-idea"];

export function callerIdentity(headers: Readonly<Record<string, string | undefined>>): CallerIdentity | null {
  const issue = headers["x-issue"];
  const agent = headers["x-butchr-agent"];
  const decoded = agent ? decodeAgentKey(agent) : null;
  if (decoded?.resourceProvider === "github-issue") {
    const ref = parseGithubIssueRef(decoded.resourceId);
    return issue || !ref ? null : { provider: "github-issue", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId, ref };
  }
  if (decoded?.resourceProvider === "jira-idea") {
    return issue ? null : { provider: "jira-idea", agent: agent!, ruleId: decoded.ruleId, resource: decoded.resourceId };
  }
  return issue ? { provider: "jira-work", issue, ...(agent ? { agent } : {}) } : null;
}
