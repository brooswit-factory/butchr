import { createCloudClient } from "jira.js";
import { createV2Client } from "confluence.js";
import type { AtlassianOps } from "./atlassian.js";

/** One paragraph of plain text as ADF (what Jira v3 wants for descriptions/comments). */
export const adf = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/**
 * The real Atlassian operations, over the de-facto SDKs (jira.js 6, confluence.js 3).
 * NOTE the 6.x config shape is `auth: { type: "basic", email, apiToken }` — the
 * older `authentication: { basic: … }` shape is silently ignored (no header sent,
 * and Jira then returns EMPTY results for searches rather than a 401).
 */
export function realAtlassian(cfg: { site: string; email: string; token: string }): AtlassianOps {
  const auth = { type: "basic" as const, email: cfg.email, apiToken: cfg.token };
  const jira: any = createCloudClient({ host: cfg.site, auth });
  const wiki: any = createV2Client({ host: cfg.site, auth });
  return {
    getIssue: (key) => jira.issues.getIssue({ issueIdOrKey: key }),
    search: (jql, maxResults) =>
      jira.issueSearch.searchAndReconsileIssuesUsingJqlPost({ jql, maxResults, fields: ["summary", "status", "issuetype", "assignee", "labels", "parent", "description"] }),
    // AddComment spreads CommentInputSchema at the TOP level: the document goes
    // in `body`, not nested under `comment` — the nested shape 400s with
    // "Comment body can not be empty!" (red/green proven live; found by a task
    // agent reporting the error inside a PR comment because it could not
    // comment on Jira).
    addComment: (key, text) => jira.issueComments.addComment({ issueIdOrKey: key, body: adf(text) }),
    linkIssues: (from, to, type) => jira.issueLinks.linkIssues({ type: { name: type }, outwardIssue: { key: from }, inwardIssue: { key: to } }),
    transition: async (key, statusName) => {
      const t = await jira.issues.getTransitions({ issueIdOrKey: key });
      const want = statusName.toLowerCase();
      const hit = (t.transitions ?? []).find((x: any) => (x.to?.name ?? x.name ?? "").toLowerCase() === want);
      if (!hit) throw new Error(`no transition to "${statusName}" from ${key}; available: ${(t.transitions ?? []).map((x: any) => x.to?.name ?? x.name).join(", ")}`);
      await jira.issues.doTransition({ issueIdOrKey: key, transition: { id: hit.id } });
      return { transitioned: key, to: statusName };
    },
    createIssue: (p) =>
      jira.issues.createIssue({
        fields: {
          project: { key: p.projectKey },
          issuetype: { name: p.issuetype },
          summary: p.summary,
          ...(p.description ? { description: adf(p.description) } : {}),
          ...(p.parent ? { parent: { key: p.parent } } : {}),
          ...(p.labels?.length ? { labels: p.labels } : {}),
          // An unassigned ticket is never staffed: the board reconciler needs an
          // assignee AND an active status before an agent runs for it.
          ...(p.assignee ? { assignee: { accountId: p.assignee } } : {}),
        },
      }),
    createPage: (p) => wiki.page.createPage({ spaceId: p.spaceId, status: "current", title: p.title, body: { representation: "storage", value: p.body } }),
    getPage: (id) => wiki.page.getPageById({ id, "body-format": "storage" }),
    listSpaces: () => wiki.space?.getSpaces?.({ limit: 50 }) ?? wiki.spaces?.getSpaces?.({ limit: 50 }),
  };
}
