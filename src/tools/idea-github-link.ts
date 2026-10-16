/** Explicit cross-provider links; provider clients enforce account/resource access. */
import { z, type ToolDef } from "@brooswit/thatch";
import { providerTarget } from "./provider-target.js";
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
    log(`  [tools] ${agent} link ${want.ideaKey} to ${want.ref}`);
    const issue = await deps.github.get(parseGithubIssueRef(want.ref)!);
    const result = await deps.ideas.linkGithubIssue(want.ideaKey, { ref: issue.ref, title: issue.title });
    return {
      ok: true, idea: want.ideaKey, ideaUrl: `${deps.site}/browse/${want.ideaKey}`, issue: issue.ref, issueUrl: issue.url,
      ...result,
    };
  }

  const tools: Record<string, ToolDef<any>> = {
    github_link_jira_idea: {
      description: "Link the target GitHub issue to an existing Jira Product Discovery idea. Provider account access applies. Idempotent; writes only a Jira remote link.",
      input: { target: z.string().optional(), idea: z.string().min(1).describe("The idea's Jira issue key, e.g. IDEA-12") },
      handler: async (a, c) => {
        const who = providerTarget(c.headers, (a as { target?: string }).target, "github-issue", parseGithubIssueRef, "github_link_jira_idea");
        const idea = (a as { idea: string }).idea.trim();
        if (!isIssueKey(idea)) throw new Refusal(`github_link_jira_idea: "${idea}" is not a Jira issue key (e.g. IDEA-12); pass the idea's key, not a URL or GitHub reference`);
        return link("github_link_jira_idea", who.agent, { ideaKey: idea, ref: who.resource, githubRuleId: who.ruleId });
      },
    },
    jira_idea_link_github_issue: {
      description: "Link the target Jira Product Discovery idea to an existing GitHub issue URL. Provider account access applies. Idempotent; writes only a Jira remote link.",
      input: { target: z.string().optional(), url: z.string().min(1).describe("The GitHub issue's web URL") },
      handler: async (a, c) => {
        const who = providerTarget(c.headers, (a as { target?: string }).target, "jira-idea", value => isIssueKey(value) ? value : null, "jira_idea_link_github_issue");
        const url = (a as { url: string }).url.trim();
        const parsed = githubIssueRefFromUrl(url);
        if (!parsed) throw new Refusal(`jira_idea_link_github_issue: ${JSON.stringify(url)} is not a GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>); pull requests, other hosts and Jira links are refused`);
        return link("jira_idea_link_github_issue", who.agent, { ideaKey: who.resource, ref: formatGithubIssueRef(parsed), ideaRuleId: who.ruleId });
      },
    },
  };
  return withOutcomeRecording(tools, log);
}
