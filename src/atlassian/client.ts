import type { JiraIssue, IssueLink, JiraComment } from "./types.js";

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

  /** Issues matching a JQL query, mapped to butchr's flat shape. */
  async search(jql: string, maxResults = 100): Promise<JiraIssue[]> {
    const q = new URLSearchParams({ jql, maxResults: String(maxResults), fields: "summary,status,issuetype,assignee,parent,updated,labels" });
    const body = await this.get(`/rest/api/3/search/jql?${q}`);
    return (body.issues ?? []).map(mapIssue);
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
    const out: IssueLink[] = [];
    for (const l of body.fields?.issuelinks ?? []) {
      if (l.outwardIssue) out.push({ type: l.type?.name ?? "", otherEnd: "outward", key: l.outwardIssue.key });
      else if (l.inwardIssue) out.push({ type: l.type?.name ?? "", otherEnd: "inward", key: l.inwardIssue.key });
    }
    return out;
  }

  /** Recent comments on a ticket, newest-first, ADF bodies flattened to plain text. */
  async comments(issueKey: string, maxResults = 20): Promise<JiraComment[]> {
    const q = new URLSearchParams({ orderBy: "-created", maxResults: String(maxResults) });
    const body = await this.get(`/rest/api/3/issue/${issueKey}/comment?${q}`);
    return (body.comments ?? []).map((c: any) => ({ id: c.id, body: adfToText(c.body), created: c.created ?? "", authorEmail: c.author?.emailAddress ?? null }));
  }
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
  };
}
