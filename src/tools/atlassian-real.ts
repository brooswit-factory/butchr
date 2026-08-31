import { createCloudClient, isNotFoundError } from "jira.js";
import { createV2Client, createV1Client } from "confluence.js";
import { createClient as createConfluenceClient } from "confluence.js/core";
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
  // confluence.js's v1 client wraps only a handful of legacy endpoints
  // (content/{archive,publish,search}) — it has NO wrapped method at all for
  // `POST /wiki/rest/api/content` (confirmed against
  // node_modules/confluence.js/dist/v1/createV1Client.d.ts: `.content` only
  // exposes archivePages/publishLegacyDraft/publishSharedDraft/searchContentByCQL).
  // That endpoint is the only one that can set `metadata.labels` atomically at
  // create time (the v2 create has no label support at all), so
  // createPageWithLabel below drives it with the bare low-level client
  // (`confluence.js/core`'s `createClient`, the same one createV1Client uses
  // internally) rather than through a wrapped call that doesn't exist.
  const wikiRaw = createConfluenceClient({ host: cfg.site, auth });
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
    // Same editIssue route as setPriority above — `fields` is a loose Record
    // with no wrapper gotcha, and it writes only the one key we pass.
    assign: (key, accountId) => jira.issues.editIssue({ issueIdOrKey: key, fields: { assignee: { accountId } } }),
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

    getProjectProperty: (projectKey, propertyKey) =>
      jira.projectProperties.getProjectProperty({ projectIdOrKey: projectKey, propertyKey }).then((r: any) => r?.value),

    // getRemoteIssueLinks with a `globalId` 404s (jira.js throws NotFoundError)
    // when no such link exists, rather than resolving an empty result (MEASURED
    // live against BUTCHR-33) — every caller wants one "not found" shape, so
    // that 404 is the only thing this op ever converts into `null`; any other
    // rejection still propagates.
    getRemoteLink: (key, globalId) =>
      jira.issueRemoteLinks.getRemoteIssueLinks({ issueIdOrKey: key, globalId }).catch((e: unknown) => {
        if (isNotFoundError(e)) return null;
        throw e;
      }),
    // MEASURED live: POSTing the same globalId twice returns the SAME link id
    // both times, with the second call's `object` winning — this idempotence
    // is what makes ensureDoc's step 5 safe to retry (src/tools/docs.ts).
    upsertRemoteLink: (key, globalId, relationship, object) =>
      jira.issueRemoteLinks.createOrUpdateRemoteIssueLink({ issueIdOrKey: key, globalId, relationship, object }),

    // GetChildPages (v2) is a DIRECT, cursor-paginated read — never CQL (see
    // docs.ts for why CQL is wrong here). `_links.next`, when present, is a
    // relative URL carrying an opaque `cursor` query param; a `new URL` needs
    // a base to parse a relative one, so an arbitrary absolute base is used
    // purely as a parsing scratchpad and discarded — MEASURED live: a
    // `limit: 1` call against a parent with 2+ children came back with
    // `_links.next` set, and following its `cursor` reached the rest.
    getChildPages: async (parentId, cursor) => {
      const r: any = await wiki.children.getChildPages({ id: parentId, limit: 50, ...(cursor ? { cursor } : {}) });
      const nextUrl: string | undefined = r?._links?.next;
      const nextCursor = nextUrl ? new URL(nextUrl, "https://placeholder.invalid").searchParams.get("cursor") : null;
      return { results: (r?.results ?? []).map((c: any) => ({ id: c.id, title: c.title })), ...(nextCursor ? { nextCursor } : {}) };
    },
    getPageLabels: (pageId) =>
      wiki.label.getPageLabels({ id: pageId }).then((r: any) => (r?.results ?? []).map((l: any) => l.name).filter(Boolean)),

    // MEASURED live against the BUTCHR space: a v1 create with `space: { key }`
    // (NOT spaceId — v1 wants the space's KEY) plus `ancestors: [{ id: parentId }]`
    // plus `metadata: { labels: [{ prefix: "global", name }] }` produced a page
    // whose label was present on an IMMEDIATE direct read (no async-index lag,
    // unlike CQL). Response shape is the legacy v1 "content" shape (`_links.base`
    // + `_links.webui` for the URL, string `id`, `title`) — NOT the v2 shape
    // `createPage`/`getPage` above return; that's the whole reason this is a
    // separate op rather than a `labels?` branch inside `createPage` — a caller
    // of the existing op must never see a shape change.
    // MEASURED live: creating a second page with the SAME title in the SAME
    // space 400s ("A page with this title already exists") and creates
    // nothing — ensureDoc's race guard (docs.ts) relies on this being a real,
    // atomic, server-enforced rejection, not a client-side check.
    createPageWithLabel: async (p) => {
      const created: any = await wikiRaw.sendRequest({
        url: "/wiki/rest/api/content",
        method: "POST",
        body: {
          type: "page",
          title: p.title,
          space: { key: p.spaceKey },
          ancestors: [{ id: p.parentId }],
          body: { storage: { value: p.body, representation: "storage" } },
          metadata: { labels: [{ prefix: "global", name: p.label }] },
        },
      });
      const base = created?._links?.base ?? `${cfg.site}/wiki`;
      return { id: created.id, title: created.title, url: `${base}${created?._links?.webui ?? ""}` };
    },

    // Read-modify-write: `fields.labels` on editIssue takes the FULL desired
    // array (same as createIssue's `labels`, confirmed by that existing
    // usage above) — there is no additive "add a label" endpoint, so this
    // reads the issue's current labels first and unions them in itself.
    addLabels: async (key, labels) => {
      const current: any = await jira.issues.getIssue({ issueIdOrKey: key, fields: ["labels"] });
      const existing: string[] = current?.fields?.labels ?? [];
      const merged = [...new Set([...existing, ...labels])];
      return jira.issues.editIssue({ issueIdOrKey: key, fields: { labels: merged } });
    },

    // MEASURED live against the BUTCHR space (BUTCHR-35): DELETE with no
    // `purge` param returns 204 and moves the page to the trash (status
    // "trashed", parentId cleared) rather than purging it — see the
    // AtlassianOps doc comment for what that does and doesn't guarantee.
    deletePage: (id) => wiki.page.deletePage({ id }),

    // MEASURED against this daemon's own credential (BUTCHR-35, 2026-08-31):
    // GET /rest/api/3/mypermissions?projectKey=BUTCHR&permissions=DELETE_ISSUES
    // returned {"DELETE_ISSUES":{...,"havePermission":false}}, and a live
    // create-then-delete round trip on a throwaway Epic 403'd with "You do
    // not have permission to delete issues in this project." — see the
    // AtlassianOps doc comment for why this op is called anyway.
    deleteIssue: (key) => jira.issues.deleteIssue({ issueIdOrKey: key }),
  };
}
