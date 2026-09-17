/**
 * The `jira-idea` resource provider's Jira side: what makes an issue a Jira
 * Product Discovery IDEA, and the read/comment client its agents use.
 *
 * Ideas travel over the same Jira Cloud REST API as work items (an Idea is
 * an issue of type `Idea` in a `product_discovery` project), and share the
 * one `AtlassianClient` transport — but they are a different resource, so
 * the boundary is enforced on BOTH sides and fails closed:
 *
 * - an issue is an idea only when Jira PROVES it: issue type `Idea` AND
 *   project type `product_discovery`;
 * - an issue that is only half of that (an `Idea` whose project type is
 *   unknown or different, or any other issue in a discovery project) is
 *   `ambiguous` — neither `jira-work` nor `jira-idea` staffs it;
 * - everything else is work.
 *
 * So a broad `jira-work` JQL can never staff an idea, and a `jira-idea` JQL
 * that also returns work items staffs only its ideas.
 *
 * GitHub issues linked to an idea are read from Jira REMOTE ISSUE LINKS
 * (`linkedGithubIssues`): the documented, durable way a Jira issue points at
 * an item in another system. Only a link whose URL is a GitHub issue's web
 * URL counts; its title and relationship are free text and decide nothing.
 * Nothing here creates, edits or deletes a link.
 *
 * NOT here, deliberately: JPD-specific fields (Impact, Effort, Goals,
 * Insights, roadmap columns, delivery progress) and idea↔work "delivery"
 * links. Those are custom fields and link types whose ids and shapes vary
 * per site and are not covered by the documented basic Idea CRUD; each needs
 * a live read proving its shape before any code depends on it (see
 * docs/jira-idea.md).
 */
import type { AtlassianClient, JiraIssueDetail } from "../atlassian/client.js";
import type { JiraComment, JiraIssue, JiraRemoteLink } from "../atlassian/types.js";
import { formatGithubIssueRef, githubIssueRefFromUrl } from "./github-issue-ref.js";

export const JIRA_IDEA_ISSUE_TYPE = "Idea";
export const JIRA_DISCOVERY_PROJECT_TYPE = "product_discovery";

export type JiraIssueClass = "idea" | "work" | "ambiguous";

/** Which provider may staff `issue` — see this file's header for the fail-closed rules. */
export function jiraIssueClass(issue: Pick<JiraIssue, "issuetype" | "projectType">): JiraIssueClass {
  const ideaType = issue.issuetype === JIRA_IDEA_ISSUE_TYPE;
  const discovery = issue.projectType === JIRA_DISCOVERY_PROJECT_TYPE;
  if (ideaType && discovery) return "idea";
  return ideaType || discovery ? "ambiguous" : "work";
}

/** A GitHub issue an idea links to through a Jira remote issue link. */
export interface LinkedGithubIssue {
  /** Canonical `owner/repo#number`, the `github-issue` resource id. */
  ref: string;
  url: string;
  /** The remote link's id, title and relationship — free text anyone who can link the idea may set. */
  remoteLinkId: string;
  title: string;
  relationship: string | null;
}

/**
 * The GitHub issues among an issue's remote links, one per issue (the first
 * link naming it wins), in Jira's order. Links to anything else — pull
 * requests, other hosts, non-URLs — are not GitHub issues and are dropped.
 */
export function linkedGithubIssues(links: readonly JiraRemoteLink[]): LinkedGithubIssue[] {
  const byRef = new Map<string, LinkedGithubIssue>();
  for (const l of links) {
    const parsed = githubIssueRefFromUrl(l.url);
    if (!parsed) continue;
    const ref = formatGithubIssueRef(parsed);
    if (!byRef.has(ref)) byRef.set(ref, { ref, url: l.url, remoteLinkId: l.id, title: l.title, relationship: l.relationship });
  }
  return [...byRef.values()];
}

export interface JiraIdeaClient {
  /**
   * One idea, re-read by key. Rejects when Jira answers with something that
   * is not a proven idea, or with a different key (a moved issue) — never
   * returns one of those.
   */
  get(key: string): Promise<JiraIssueDetail>;
  /** Every comment on the idea, oldest first. Does not re-check the type; `get` does. */
  comments(key: string): Promise<JiraComment[]>;
  /** Post a comment after `get` confirms the target is still this idea. */
  addComment(key: string, text: string): Promise<JiraComment>;
  /** The GitHub issues the idea's remote links name, after `get` confirms the target is still this idea. */
  githubIssues(key: string): Promise<LinkedGithubIssue[]>;
}

export function createJiraIdeaClient(jira: Pick<AtlassianClient, "issue" | "allComments" | "addComment" | "remoteLinks">): JiraIdeaClient {
  const get = async (key: string): Promise<JiraIssueDetail> => {
    const issue = await jira.issue(key);
    if (issue.key !== key) throw new Error(`Jira answered ${issue.key} for ${key}; refusing a moved issue`);
    const cls = jiraIssueClass(issue);
    if (cls !== "idea") {
      throw new Error(`${key} is not a Jira Product Discovery idea (issue type "${issue.issuetype}", project type "${issue.projectType ?? "unknown"}")`);
    }
    return issue;
  };
  return {
    get,
    comments: (key) => jira.allComments(key),
    async addComment(key, text) {
      await get(key);
      return jira.addComment(key, text);
    },
    async githubIssues(key) {
      await get(key);
      return linkedGithubIssues(await jira.remoteLinks(key));
    },
  };
}
