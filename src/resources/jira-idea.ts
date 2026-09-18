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
 * The one link write is `linkGithubIssue`: an idempotent create keyed by a
 * deterministic `globalId`, made only by the explicit connection tools
 * (src/tools/idea-github-link.ts). Nothing here edits or deletes a link.
 *
 * NOT here, deliberately: JPD-specific fields (Impact, Effort, Goals,
 * Insights, roadmap columns, delivery progress) and idea↔work "delivery"
 * links. Those are custom fields and link types whose ids and shapes vary
 * per site and are not covered by the documented basic Idea CRUD; each needs
 * a live read proving its shape before any code depends on it (see
 * docs/jira-idea.md).
 */
import type { AtlassianClient, JiraIssueDetail } from "../atlassian/client.js";
import type { JiraComment, JiraIssue, JiraRemoteLink, JiraRemoteLinkInput } from "../atlassian/types.js";
import { formatGithubIssueRef, githubIssueRefFromUrl, parseGithubIssueRef } from "./github-issue-ref.js";

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

/**
 * The `globalId` Butchr writes for a link to GitHub issue `ref` (canonical,
 * lowercased): one per issue on an idea, so a retried or concurrent write
 * updates the same link instead of adding a second. Uses the
 * `system=<url>&id=<id>` shape Atlassian's remote link guide suggests.
 */
export const githubIssueGlobalId = (ref: string): string => `system=https://github.com&id=${ref}`;

/** Jira's remote link title limit is not documented per field; stay inside the 255 characters `globalId` allows. */
const REMOTE_LINK_TITLE_MAX = 255;

/**
 * The remote link Butchr writes for a GitHub issue: a plain web link to the
 * canonical issue URL, visible to people in the idea's links panel, titled
 * with the issue ref and its title at link time.
 */
export function githubIssueRemoteLink(issue: { ref: string; title: string }): JiraRemoteLinkInput {
  const r = parseGithubIssueRef(issue.ref);
  if (!r) throw new Error(`invalid GitHub issue reference: ${JSON.stringify(issue.ref)}`);
  const title = `${issue.ref}: ${issue.title}`.replace(/\s+/g, " ").trim();
  return {
    globalId: githubIssueGlobalId(issue.ref),
    relationship: "GitHub issue",
    object: {
      url: `https://github.com/${r.owner}/${r.repo}/issues/${r.number}`,
      title: title.length > REMOTE_LINK_TITLE_MAX ? `${title.slice(0, REMOTE_LINK_TITLE_MAX - 1)}…` : title,
      icon: { url16x16: "https://github.com/favicon.ico", title: "GitHub" },
    },
  };
}

/** What `linkGithubIssue` did: `created` is false when the idea already linked the issue (no write) or Jira updated an existing link. */
export interface GithubIssueLinkResult { remoteLinkId: string; created: boolean; alreadyLinked: boolean }

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
  /**
   * Link the idea to a GitHub issue the caller has already verified, after
   * `get` confirms the target. Any existing remote link naming the issue
   * (Butchr's or a person's) makes this a no-op; otherwise one create-or-
   * update keyed by `githubIssueGlobalId`.
   */
  linkGithubIssue(key: string, issue: { ref: string; title: string }): Promise<GithubIssueLinkResult>;
}

export function createJiraIdeaClient(jira: Pick<AtlassianClient, "issue" | "allComments" | "addComment" | "remoteLinks" | "upsertRemoteLink">): JiraIdeaClient {
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
    async linkGithubIssue(key, issue) {
      const link = githubIssueRemoteLink(issue);
      await get(key);
      const existing = linkedGithubIssues(await jira.remoteLinks(key)).find((l) => l.ref === issue.ref);
      if (existing) return { remoteLinkId: existing.remoteLinkId, created: false, alreadyLinked: true };
      const written = await jira.upsertRemoteLink(key, link);
      return { remoteLinkId: written.id, created: written.created, alreadyLinked: false };
    },
  };
}
