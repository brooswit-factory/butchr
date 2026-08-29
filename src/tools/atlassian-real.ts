import { createCloudClient } from "jira.js";
import { createV2Client, createV1Client } from "confluence.js";
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
  // CQL search (confluence_search_pages) has no v2 equivalent in this SDK — the v2 client
  // exposes no `search` namespace at all (confirmed against node_modules/confluence.js/dist/v2/createV2Client.d.ts).
  // The v1 (legacy "content") API's /wiki/rest/api/search still serves CQL and is not
  // deprecated, so a second client, same host/auth, is the documented way to reach it.
  const wiki1: any = createV1Client({ host: cfg.site, auth });
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
          ...(p.priority ? { priority: { name: p.priority } } : {}),
        },
      }),
    // editIssue's `fields` is a loose Record<string, any> (confirmed in
    // node_modules/jira.js/dist/cloud/parameters/editIssue.d.ts) — no wrapper
    // gotcha here, unlike addComment/createPage.
    setPriority: (key, priority) => jira.issues.editIssue({ issueIdOrKey: key, fields: { priority: { name: priority } } }),
    // CreatePage spreads CreatePageSchema at the TOP level: only `body` is
    // forwarded (zod, $strip — every other top-level key, including spaceId,
    // is silently dropped) — the flat shape sent an empty spaceId and
    // Atlassian 400'd with "spaceId: must not be null" (red/green proven).
    // parentId nests under `body` for the same reason; omitted, Confluence
    // falls back to the space's own default parent (unchanged behavior).
    createPage: (p) =>
      wiki.page.createPage({
        body: {
          spaceId: p.spaceId, status: "current", title: p.title,
          body: { representation: "storage", value: p.body },
          ...(p.parentId ? { parentId: p.parentId } : {}),
        },
      }),
    // GetPageById reads parameters.bodyFormat (not "body-format") and maps it
    // to the 'body-format' search param itself — the old key never reached
    // the request, so every read came back with an empty body (red/green
    // proven, fixed 0.5.18). bodyFormat is always requested now, so the old
    // failure mode (body silently absent) can't recur here — but a caller
    // reading just the raw result still can't tell "empty page" from "body
    // wasn't in the response" without re-deriving that assumption itself.
    // bodyRequested/bodyLength make it explicit instead of implicit.
    getPage: (id) =>
      wiki.page.getPageById({ id, bodyFormat: "storage" }).then((r: any) => ({
        ...r,
        bodyRequested: true,
        bodyLength: r?.body?.storage?.value?.length ?? 0,
      })),
    // UpdatePage reads parameters.id (for the URL) and parameters.body (the PUT
    // body) — everything else at the top level is dropped, same top-level-key
    // gotcha as createPage (confirmed against
    // node_modules/confluence.js/dist/v2/api/page.js: `updatePage` builds its
    // request from exactly `parameters.id` and `parameters.body`, nothing
    // else). Unlike createPage, `id` DOES need to be at the top level too
    // (it's used to build the URL, not sent in the body) — but Confluence's
    // v2 update-page body ALSO wants `id` again inside it, alongside status/
    // title/body/version; the API 400s without it there. Optimistic locking
    // is handled inside this wrapper, not by callers: read the current
    // version, PUT version.number + 1, with a version message so the edit
    // history says who/why. UpdatePageSchema declares `id: z.ZodNumber`, but
    // the string we pass here is harmless: the core client only validates the
    // RESPONSE against a schema (core/createClient.js), never the outgoing
    // parameters — `id` is only ever interpolated into the URL, never parsed.
    updatePage: async (p) => {
      const current: any = await wiki.page.getPageById({ id: p.id, bodyFormat: "storage" });
      const nextVersion = (current?.version?.number ?? 0) + 1;
      return wiki.page.updatePage({
        id: p.id,
        body: {
          id: p.id,
          status: "current",
          title: p.title ?? current?.title,
          body: { representation: "storage", value: p.body },
          version: { number: nextVersion, message: "butchr: confluence_update_page" },
        },
      });
    },
    // searchByCQL reads every parameter by name off the top level as GET
    // searchParams (node_modules/confluence.js/dist/v1/api/search.js) — no
    // body-forwarding gotcha here, unlike the page-write endpoints above.
    searchPages: (cql, limit) => wiki1.search.searchByCQL({ cql, limit }),
    listSpaces: () => wiki.space?.getSpaces?.({ limit: 50 }) ?? wiki.spaces?.getSpaces?.({ limit: 50 }),
  };
}
