/**
 * The one explicit connection operation between the two intake providers:
 * link an EXISTING GitHub issue to an EXISTING Jira Product Discovery idea
 * with a Jira remote issue link. Nothing here creates an idea or an issue,
 * links anything on its own, or writes to GitHub.
 *
 * Two tools, one per side, each with the caller's own resource fixed by its
 * agent key (src/mcp/identity.ts) and the other named by argument:
 *
 * - `github_link_jira_idea` — a `github-issue` agent names an idea KEY;
 * - `jira_idea_link_github_issue` — a `jira-idea` agent names an issue URL.
 *
 * Both run the same checks, in order, and write nothing until all pass:
 *
 * 1. Shape: the argument must be the other provider's identifier (a Jira key
 *    for the GitHub side, an `https://github.com/<owner>/<repo>/issues/<n>`
 *    URL for the idea side). A pull request, a Jira URL or a GitHub ref where
 *    a key belongs is refused, never coerced.
 * 2. Configuration (`authorizeIdeaGithubLink`): the RECEIVING idea rule must
 *    list the SENDING github-issue rule in `inwardConnectionRules`, and both
 *    rules must currently match their resource — the same last complete loop
 *    matches routing uses. A caller whose own match has lapsed is refused. So
 *    the issue is inside the rule's org and `repo:` scope by construction.
 * 3. Live resources: the issue is re-read from GitHub (an issue, not a pull
 *    request, inside `BUTCHR_GITHUB_ORGS`, not transferred) and the idea from
 *    Jira (a proven idea, not moved).
 * 4. Write (`JiraIdeaClient#linkGithubIssue`): no-op when the idea already
 *    links the issue; otherwise Jira's create-or-update keyed by a
 *    deterministic `globalId`, so retries and races leave one link.
 */
import { z, type ToolDef } from "@brooswit/thatch";
import { callerIdentity } from "../mcp/identity.js";
import type { GithubIssueClient } from "../resources/github-issue.js";
import { formatGithubIssueRef, githubIssueRefFromUrl, parseGithubIssueRef } from "../resources/github-issue-ref.js";
import { isIssueKey } from "../resources/id.js";
import type { JiraIdeaClient } from "../resources/jira-idea.js";
import type { GithubIssueMatch } from "../rules/github-issue-type.js";
import type { RuleMatch } from "../rules/resource-type.js";
import { Refusal, withOutcomeRecording } from "./outcome.js";

export type IdeaGithubLinkAuthorization =
  | { ok: true; ideaRule: string; githubRule: string }
  | { ok: false; reason: string };

/**
 * Whether idea `ideaKey` may be linked to GitHub issue `ref`, from current
 * matches alone. The caller's own rule is pinned (`ideaRuleId` for an idea
 * agent, `githubRuleId` for a GitHub agent) and must still match its own
 * resource; the other side may be any rule that makes the pair allowed.
 */
export function authorizeIdeaGithubLink(
  want: { ideaKey: string; ref: string; ideaRuleId?: string; githubRuleId?: string },
  ideaMatches: readonly RuleMatch[],
  githubMatches: readonly GithubIssueMatch[],
): IdeaGithubLinkAuthorization {
  const ideas = ideaMatches.filter((m) => m.rule.resourceProvider === "jira-idea" && m.issue.key === want.ideaKey && (!want.ideaRuleId || m.rule.id === want.ideaRuleId));
  const issues = githubMatches.filter((m) => m.rule.resourceProvider === "github-issue" && m.issue.ref === want.ref && (!want.githubRuleId || m.rule.id === want.githubRuleId));
  if (want.ideaRuleId && !ideas.length) return { ok: false, reason: `rule ${want.ideaRuleId} does not currently match idea ${want.ideaKey}` };
  if (want.githubRuleId && !issues.length) return { ok: false, reason: `rule ${want.githubRuleId} does not currently match GitHub issue ${want.ref}` };
  const pairs = ideas.flatMap((i) => issues
    .filter((g) => i.rule.relationships?.inwardConnectionRules?.includes(g.rule.id))
    .map((g) => ({ ideaRule: i.rule.id, githubRule: g.rule.id })));
  pairs.sort((a, b) => (a.ideaRule + ":" + a.githubRule).localeCompare(b.ideaRule + ":" + b.githubRule));
  if (pairs[0]) return { ok: true, ...pairs[0] };
  if (want.ideaRuleId) return { ok: false, reason: `GitHub issue ${want.ref} is not currently matched by any github-issue rule that rule ${want.ideaRuleId} lists in inwardConnectionRules` };
  return { ok: false, reason: `idea ${want.ideaKey} is not currently matched by any jira-idea rule whose inwardConnectionRules lists rule ${want.githubRuleId}` };
}

export interface IdeaGithubLinkToolDeps {
  ideas: Pick<JiraIdeaClient, "linkGithubIssue">;
  github: Pick<GithubIssueClient, "get">;
  /** The jira-idea loop's latest complete matches. */
  ideaMatches: () => readonly RuleMatch[];
  /** The github-issue loop's latest complete matches. */
  githubMatches: () => readonly GithubIssueMatch[];
  /** Jira site base URL, for the idea's browse link. */
  site: string;
  log?: (line: string) => void;
}

export function ideaGithubLinkTools(deps: IdeaGithubLinkToolDeps): Record<string, ToolDef<any>> {
  const log = deps.log ?? console.error;

  async function link(verb: string, agent: string, want: { ideaKey: string; ref: string; ideaRuleId?: string; githubRuleId?: string }) {
    const auth = authorizeIdeaGithubLink(want, deps.ideaMatches(), deps.githubMatches());
    if (!auth.ok) {
      log(`  [tools] ${agent} → refused ${verb} ${want.ideaKey} ↔ ${want.ref}: ${auth.reason}`);
      throw new Refusal(`${verb}: ${auth.reason}`);
    }
    log(`  [tools] ${agent} → link ${want.ideaKey} ↔ ${want.ref} (idea rule ${auth.ideaRule} hears ${auth.githubRule})`);
    const issue = await deps.github.get(parseGithubIssueRef(want.ref)!);
    const result = await deps.ideas.linkGithubIssue(want.ideaKey, { ref: issue.ref, title: issue.title });
    return {
      ok: true, idea: want.ideaKey, ideaUrl: `${deps.site}/browse/${want.ideaKey}`, issue: issue.ref, issueUrl: issue.url,
      ideaRule: auth.ideaRule, githubRule: auth.githubRule, ...result,
    };
  }

  const tools: Record<string, ToolDef<any>> = {
    github_link_jira_idea: {
      description: "Link YOUR OWN GitHub issue to an existing Jira Product Discovery idea, by adding a remote link on the idea that people can see in Jira. Allowed only when a jira-idea rule matching that idea lists your rule in inwardConnectionRules. Safe to retry: an idea already linking your issue is left as it is. Writes nothing to GitHub and creates no idea.",
      input: { idea: z.string().min(1).describe("The idea's Jira issue key, e.g. IDEA-12") },
      handler: async (a, c) => {
        const who = callerIdentity(c.headers);
        if (who?.provider !== "github-issue") throw new Refusal("github_link_jira_idea: only a github-issue agent may call this — it links the caller's own GitHub issue");
        const idea = (a as { idea: string }).idea.trim();
        if (!isIssueKey(idea)) throw new Refusal(`github_link_jira_idea: "${idea}" is not a Jira issue key (e.g. IDEA-12); pass the idea's key, not a URL or GitHub reference`);
        return link("github_link_jira_idea", who.agent, { ideaKey: idea, ref: who.resource, githubRuleId: who.ruleId });
      },
    },
    jira_idea_link_github_issue: {
      description: "Link YOUR OWN Jira Product Discovery idea to an existing GitHub issue, by adding a remote link on the idea that people can see in Jira. Pass the issue's https://github.com/<owner>/<repo>/issues/<n> URL; pull requests are refused. Allowed only when your rule lists, in inwardConnectionRules, a github-issue rule currently matching that issue. Safe to retry: an idea already linking the issue is left as it is. Writes nothing to GitHub and creates no issue.",
      input: { url: z.string().min(1).describe("The GitHub issue's web URL") },
      handler: async (a, c) => {
        const who = callerIdentity(c.headers);
        if (who?.provider !== "jira-idea") throw new Refusal("jira_idea_link_github_issue: only a jira-idea agent may call this — it links the caller's own Product Discovery idea");
        const url = (a as { url: string }).url.trim();
        const parsed = githubIssueRefFromUrl(url);
        if (!parsed) throw new Refusal(`jira_idea_link_github_issue: ${JSON.stringify(url)} is not a GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>); pull requests, other hosts and Jira links are refused`);
        return link("jira_idea_link_github_issue", who.agent, { ideaKey: who.resource, ref: formatGithubIssueRef(parsed), ideaRuleId: who.ruleId });
      },
    },
  };
  return withOutcomeRecording(tools, log);
}
