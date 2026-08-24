import type { JiraIssue, IssueLink } from "./types.js";

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
    const q = new URLSearchParams({ jql, maxResults: String(maxResults), fields: "summary,status,issuetype,assignee,updated" });
    const body = await this.get(`/rest/api/3/search/jql?${q}`);
    return (body.issues ?? []).map(mapIssue);
  }

  /** The issue links on a ticket, as the other end's key + relationship. */
  async links(issueKey: string): Promise<IssueLink[]> {
    const body = await this.get(`/rest/api/3/issue/${issueKey}?fields=issuelinks`);
    const out: IssueLink[] = [];
    for (const l of body.fields?.issuelinks ?? []) {
      if (l.outwardIssue) out.push({ type: l.type?.name ?? "", direction: "outward", key: l.outwardIssue.key });
      else if (l.inwardIssue) out.push({ type: l.type?.name ?? "", direction: "inward", key: l.inwardIssue.key });
    }
    return out;
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
    updated: f.updated ?? "",
  };
}
