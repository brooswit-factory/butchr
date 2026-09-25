import type { JiraIssue, IssueLink, JiraComment, JiraRemoteLink, JiraRemoteLinkInput } from "./types.js";

/** One issue read by key, with its description flattened to plain text. */
export interface JiraIssueDetail extends JiraIssue { description: string }

/** ADF node shape is large and mostly irrelevant here; walk it structurally. */
interface AdfNode { type?: string; text?: string; content?: AdfNode[] }

/** Block-level node types whose children are distinct lines, not one run of text. */
const ADF_BLOCK_TYPES = new Set(["doc", "bulletList", "orderedList"]);

/**
 * Flatten an ADF document (or any node within one) to plain text: every
 * `text` node concatenated, block-level nodes (doc, lists) joined with "\n",
 * inline containers (paragraphs, list items) concatenated directly so a
 * `hardBreak` supplies the only newline within them. This is the piece most
 * likely to silently return "" and kill the whole comment-reading path.
 */
export function adfToText(node: AdfNode | null | undefined): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const parts = (node.content ?? []).map(adfToText);
  return node.type && ADF_BLOCK_TYPES.has(node.type) ? parts.join("\n") : parts.join("");
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A non-2xx Atlassian response, carrying the status so callers can act on it (e.g. retry a 403 differently). */
export class AtlassianHttpError extends Error {
  constructor(readonly status: number, method: string, path: string, bodySnippet: string) {
    super(`Atlassian ${status} on ${method} ${path}: ${bodySnippet}`);
    this.name = "AtlassianHttpError";
  }
}

const SEARCH_FIELDS = "summary,status,issuetype,assignee,parent,updated,labels,issuelinks,project,description";

/**
 * A thin Jira Cloud REST client using classic-token Basic auth. `fetch` is
 * injectable so the client is testable without the network. Small on purpose —
 * only what butchr needs (search assigned issues, read a ticket's links).
 */
export class AtlassianClient {
  private readonly auth: string;
  constructor(
    private readonly site: string,
    email: string,
    token: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.site}${path}`, {
      headers: { authorization: this.auth, accept: "application/json" },
    });
    if (!res.ok) throw new AtlassianHttpError(res.status, "GET", path, (await res.text()).slice(0, 200));
    return res.json();
  }

  /**
   * Whether this account may suppress notifications (`notifyUsers=false`) on
   * `projectKey` — Jira Cloud requires Administer Jira (global) or Administer
   * Projects on that project for it, otherwise the whole write 403s. A failed
   * check (network error, non-2xx) never throws: it's logged once, naming the
   * request, and treated as "no" — degrading to notifying writes is always
   * safe, assuming permission and 403ing every write is not.
   */
  async canSuppressNotifications(projectKey: string): Promise<boolean> {
    try {
      const body = await this.get(`/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=ADMINISTER_PROJECTS,ADMINISTER`);
      return Boolean(body.permissions?.ADMINISTER_PROJECTS?.havePermission || body.permissions?.ADMINISTER?.havePermission);
    } catch (e) {
      this.log(`[atlassian] mypermissions check for project ${projectKey} failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /**
   * Issues matching a JQL query, mapped to butchr's flat shape.
   *
   * BUTCHR-169: `issuelinks` was added to `fields` so `ISSUE_SPAWN_CONFIG
   * .specFor` (src/resources/issue.ts) can derive a ticket's REAL boss (an
   * inward `Implements` link) without a second, per-issue API call on every
   * poll — the same reason `parent` (Jira's native field, structurally
   * unable to carry this fleet's boss relationship — see JiraIssue's own
   * doc comment) was already batched into this one query instead of fetched
   * separately.
   */
  async search(jql: string, maxResults = 100): Promise<JiraIssue[]> {
    const q = new URLSearchParams({ jql, maxResults: String(maxResults), fields: SEARCH_FIELDS });
    const body = await this.get(`/rest/api/3/search/jql?${q}`);
    return (body.issues ?? []).map(mapIssue);
  }

  /**
   * EVERY issue matching `jql`, following `nextPageToken` — or a throw, never
   * a silently truncated list. For callers where a missing issue means
   * something (the rule engine reads absence as "left the query" and stops
   * that agent), `search`'s first-page-only result is unsafe. More than
   * `maxIssues` matches also throws: that query is almost certainly a
   * mistake, and failing the poll is better than staffing it.
   */
  async searchAll(jql: string, maxIssues = 1000, pageSize = 100): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ jql, maxResults: String(pageSize), fields: SEARCH_FIELDS, ...(token ? { nextPageToken: token } : {}) });
      const body = await this.get(`/rest/api/3/search/jql?${q}`);
      out.push(...(body.issues ?? []).map(mapIssue));
      if (out.length > maxIssues) throw new Error(`JQL matched more than ${maxIssues} issues — refusing a partial result: ${jql}`);
      const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
      if (body.isLast === false && !next) throw new Error(`Jira reported more results without a nextPageToken — refusing a partial result: ${jql}`);
      if (next !== undefined && next === token) throw new Error(`Jira repeated nextPageToken — refusing a partial result: ${jql}`);
      token = next;
    } while (token);
    return out;
  }

  /**
   * Add/remove labels on a ticket in one request — never a wholesale field
   * set, so labels outside the caller's add/remove lists (human labels) are
   * left untouched. A no-op (no request) when both lists are empty.
   *
   * `notify` defaults to false (quiet, `notifyUsers=false`) — Jira Cloud
   * honours that only for an account holding Administer Jira/Projects on the
   * ticket's project, and 403s the WHOLE request for anyone else. Callers
   * that don't hold the permission must pass `notify: true` (a normal,
   * watcher-notifying write) or every label write fails.
   */
  async updateLabels(key: string, ops: { add?: readonly string[]; remove?: readonly string[] }, opts?: { notify?: boolean }): Promise<void> {
    const update = [
      ...(ops.add ?? []).map((label) => ({ add: label })),
      ...(ops.remove ?? []).map((label) => ({ remove: label })),
    ];
    if (!update.length) return;
    const path = `/rest/api/3/issue/${key}${opts?.notify ? "" : "?notifyUsers=false"}`;
    const res = await this.fetchImpl(`${this.site}${path}`, {
      method: "PUT",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ update: { labels: update } }),
    });
    if (!res.ok) throw new AtlassianHttpError(res.status, "PUT", path, (await res.text()).slice(0, 200));
  }

  /** The issue links on a ticket, as the other end's key + relationship. */
  async links(issueKey: string): Promise<IssueLink[]> {
    const body = await this.get(`/rest/api/3/issue/${issueKey}?fields=issuelinks`);
    return parseIssueLinks(body.fields?.issuelinks);
  }

  /**
   * One issue by key or id, with the search fields plus its description.
   * Jira answers a moved issue's OLD key with the issue under its NEW key,
   * so callers that act on a specific key must compare `key` themselves.
   */
  async issue(issueKey: string): Promise<JiraIssueDetail> {
    // BUTCHR-431: `SEARCH_FIELDS` already carries "description" (added so
    // `search()`/`searchAll()` can feed it to link discovery) — no need to
    // append it a second time here.
    const body = await this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${SEARCH_FIELDS}`);
    if (!body || typeof body.key !== "string") throw new Error(`Jira issue read for ${issueKey} returned an unexpected body`);
    return { ...mapIssue(body), description: adfToText(body.fields?.description) };
  }

  /** EVERY comment on a ticket, oldest first — or a throw, never a silently partial list. */
  async allComments(issueKey: string, maxComments = 1000, pageSize = 100): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    for (;;) {
      const q = new URLSearchParams({ orderBy: "created", startAt: String(out.length), maxResults: String(pageSize) });
      const body = await this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${q}`);
      if (!Array.isArray(body?.comments) || typeof body.total !== "number") throw new Error(`Jira comments for ${issueKey} returned an unexpected body`);
      out.push(...body.comments.map(mapComment));
      if (out.length > maxComments) throw new Error(`Jira comments for ${issueKey} exceed ${maxComments} — refusing a partial list`);
      if (out.length >= body.total) return out;
      if (!body.comments.length) throw new Error(`Jira comments for ${issueKey} stopped before the reported total (${body.total}) — refusing a partial list`);
    }
  }

  /** Post a plain-text comment (one ADF paragraph, the same shape `adf()` in src/tools/atlassian-real.ts sends). */
  async addComment(issueKey: string, text: string): Promise<JiraComment> {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const res = await this.fetchImpl(`${this.site}${path}`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
    });
    if (!res.ok) throw new AtlassianHttpError(res.status, "POST", path, (await res.text()).slice(0, 200));
    return mapComment(await res.json());
  }

  /**
   * Every remote issue link on a ticket, as Jira orders them — or a throw on
   * an unexpected body, never a silently empty list. Read-only. Entries
   * without the two fields Jira requires (`object.url`, `object.title`) are
   * dropped. Needs Browse projects, and issue linking active on the site.
   */
  async remoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
    const body = await this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`);
    if (!Array.isArray(body)) throw new Error(`Jira remote links for ${issueKey} returned an unexpected body`);
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return body.flatMap((l: any): JiraRemoteLink[] => {
      const url = str(l?.object?.url), title = str(l?.object?.title);
      if (url === null || title === null || (typeof l.id !== "number" && typeof l.id !== "string")) return [];
      return [{ id: String(l.id), globalId: str(l.globalId), relationship: str(l.relationship), url, title, applicationType: str(l.application?.type) }];
    });
  }

  /**
   * BUTCHR-437 (epic BUTCHR-421, story 3/4): a Confluence page's CURRENT
   * `version.number`, for the Confluence link poller
   * (src/jira-watch/external-poll.ts) — same call shape `get_doc`/
   * `confluence_get_page` already use (`GET /wiki/api/v2/pages/{id}`, no
   * `body-format` requested, so this never pulls the page's body content the
   * way `get_doc` does), over the SAME site + Basic-auth credential this
   * class already carries for Jira (Atlassian Cloud accepts one credential
   * across both REST APIs for one account). Never throws on a 404/403 — a
   * genuinely unreadable/gone page is a fact the poller needs to classify as
   * "unreadable", not an exception to catch a second time — so this resolves
   * a tagged union instead, the same "one not-found shape, not a try/catch
   * each" discipline `getRemoteLink` (src/tools/atlassian.ts) already
   * documents for itself. Any OTHER non-2xx (5xx, a timeout the fetchImpl
   * itself rejects with) resolves `{ok:false, transient:true}` — a fact the
   * poller must retry, never report as unreadable (mirrors this story's own
   * Jira-kind precedent: a search failure must never read as "every link
   * unreadable").
   */
  async confluencePageVersion(pageId: string): Promise<{ ok: true; version: number } | { ok: false; transient: false; httpStatus: number } | { ok: false; transient: true }> {
    try {
      const body = await this.get(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`);
      const version = body?.version?.number;
      if (typeof version !== "number") throw new Error(`Confluence page ${pageId} read returned no version.number`);
      return { ok: true, version };
    } catch (e) {
      if (e instanceof AtlassianHttpError && (e.status === 404 || e.status === 403)) return { ok: false, transient: false, httpStatus: e.status };
      if (e instanceof AtlassianHttpError) return { ok: false, transient: true };
      throw e;
    }
  }

  /**
   * `POST /rest/api/3/issue/{key}/remotelink`: Jira's documented create-or-
   * update. When `globalId` names a remote link already on the issue, that
   * link is updated (every field not sent becomes null) and Jira answers 200;
   * otherwise a link is created and Jira answers 201. Needs Browse projects
   * and Link issues on the issue's project; a 401/403/404 throws.
   */
  async upsertRemoteLink(issueKey: string, link: JiraRemoteLinkInput): Promise<{ id: string; created: boolean }> {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`;
    const res = await this.fetchImpl(`${this.site}${path}`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(link),
    });
    if (!res.ok) throw new AtlassianHttpError(res.status, "POST", path, (await res.text()).slice(0, 200));
    const body = await res.json() as { id?: unknown };
    if (typeof body?.id !== "number" && typeof body?.id !== "string") throw new Error(`Jira remote link write for ${issueKey} returned an unexpected body`);
    return { id: String(body.id), created: res.status === 201 };
  }

  /** Recent comments on a ticket, newest-first, ADF bodies flattened to plain text. */
  async comments(issueKey: string, maxResults = 20): Promise<JiraComment[]> {
    const q = new URLSearchParams({ orderBy: "-created", maxResults: String(maxResults) });
    const body = await this.get(`/rest/api/3/issue/${issueKey}/comment?${q}`);
    return (body.comments ?? []).map(mapComment);
  }
}

/**
 * Shared by `links()` (single-issue endpoint) and `mapIssue` (search
 * results) — same raw Jira `issuelinks` array shape either way, so this is
 * one place to get the inward/outward mapping right instead of two that
 * could drift (see `IssueLink`'s own doc comment, src/atlassian/types.ts,
 * for the direction convention this preserves). Defensive against a missing
 * array (an issue with no links, or a caller that didn't request the
 * field) — always returns `[]`, never throws.
 */
function parseIssueLinks(raw: any[] | undefined): IssueLink[] {
  const out: IssueLink[] = [];
  for (const l of raw ?? []) {
    // BUTCHR-200: `status` is read off the other end's own `fields.status.name`
    // (the same nested shape `mapIssue` reads for the top-level issue) and
    // only added to the flattened stub when present — `undefined` means
    // UNKNOWN, never a fabricated "not Done". MEASURED (BUTCHR-192): Jira
    // hydrates `status` on this stub for both `inwardIssue` and
    // `outwardIssue`; every other field on the stub's own `fields` object
    // (e.g. `labels` — confirmed NEVER present, in either direction) is
    // deliberately still discarded, exactly as before this change.
    if (l.outwardIssue) out.push({ type: l.type?.name ?? "", otherEnd: "outward", key: l.outwardIssue.key, ...(l.outwardIssue.fields?.status?.name !== undefined ? { status: l.outwardIssue.fields.status.name } : {}) });
    else if (l.inwardIssue) out.push({ type: l.type?.name ?? "", otherEnd: "inward", key: l.inwardIssue.key, ...(l.inwardIssue.fields?.status?.name !== undefined ? { status: l.inwardIssue.fields.status.name } : {}) });
  }
  return out;
}

function mapComment(c: any): JiraComment {
  return { id: c.id, body: adfToText(c.body), created: c.created ?? "", authorEmail: c.author?.emailAddress ?? null };
}

function mapIssue(i: any): JiraIssue {
  const f = i.fields ?? {};
  return {
    key: i.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    issuetype: f.issuetype?.name ?? "",
    assignee: f.assignee?.displayName ?? null,
    parent: f.parent?.key ?? null,
    updated: f.updated ?? "",
    labels: f.labels ?? [],
    ...(typeof f.project?.projectTypeKey === "string" ? { projectType: f.project.projectTypeKey } : {}),
    // BUTCHR-169: only set when the caller's `fields` included "issuelinks"
    // (search() does; nothing else calling mapIssue needs to) — `undefined`
    // when absent from the response, never a fabricated `[]` standing in
    // for "I checked and there are none" (see JiraIssue's own doc comment).
    ...(f.issuelinks !== undefined ? { issuelinks: parseIssueLinks(f.issuelinks) } : {}),
    // BUTCHR-431: same discipline — only set when the response carried a
    // "description" field at all (search()/searchAll() always ask for it
    // now; a raw fixture that predates this field simply omits it). Jira
    // returns ADF or an explicit `null` for an empty description; `adfToText`
    // tolerates both (and any other odd shape) without throwing, so a null
    // description maps to `""`, never a crash.
    ...(f.description !== undefined ? { description: adfToText(f.description) } : {}),
  };
}
