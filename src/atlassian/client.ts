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
  ) {
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.site}${path}`, {
      headers: { authorization: this.auth, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Atlassian ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
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
   */
  async updateLabels(key: string, ops: { add?: readonly string[]; remove?: readonly string[] }): Promise<void> {
    const update = [
      ...(ops.add ?? []).map((label) => ({ add: label })),
      ...(ops.remove ?? []).map((label) => ({ remove: label })),
    ];
    if (!update.length) return;
    const res = await this.fetchImpl(`${this.site}/rest/api/3/issue/${key}?notifyUsers=false`, {
      method: "PUT",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ update: { labels: update } }),
    });
    if (!res.ok) throw new Error(`Atlassian ${res.status} on PUT /rest/api/3/issue/${key}: ${(await res.text()).slice(0, 200)}`);
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
    return (body.comments ?? []).map((c: any) => ({ id: c.id, body: adfToText(c.body), created: c.created ?? "" }));
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
