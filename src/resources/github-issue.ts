/**
 * The `github-issue` resource provider's GitHub side: rule-query validation,
 * org scoping, and a read-only REST client for issues and their comments.
 *
 * READ-ONLY. Nothing here creates, edits, labels, or comments on anything.
 *
 * Auth and scope reuse the pr:* discovery configuration (src/config/config.ts
 * `github`): the token from `GITHUB_TOKEN_FILE`, and `BUTCHR_GITHUB_ORGS` as
 * the only owners a query may reach. An unscoped GitHub search spans all of
 * GitHub, so every search is pinned to those orgs (or to `repo:` qualifiers
 * inside them), and results owned by anyone else are dropped.
 *
 * Pull requests are never issues: every search adds `is:issue`, queries that
 * ask for pull requests are rejected at rule-load time, and any result that
 * carries a `pull_request` field is dropped regardless.
 *
 * Issue types (Bug, Feature, Task, or whatever an org defines) are read from
 * the issue's `type` field when GitHub returns one; rules select them with
 * GitHub's own `type:` qualifier.
 */
import { ghHeaders, type FetchLike } from "../labels/pr.js";
import { formatGithubIssueRef, isGithubOwner, isGithubRepo, type GithubIssueRef } from "./github-issue-ref.js";

export interface GithubIssue {
  /** Canonical `owner/repo#number` — the resource id. */
  ref: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  /** The issue type's name (e.g. `Bug`, `Feature`, `Task`), or null when the repo has none set. */
  issueType: string | null;
  labels: string[];
  /** GitHub's comment count, as returned with the issue. */
  comments: number;
  updated: string;
  url: string;
}

export interface GithubComment { id: string; author: string | null; body: string; created: string; updated: string }

export class GithubHttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`GitHub ${what} failed: HTTP ${status}`);
    this.name = "GithubHttpError";
  }
}

/** Split on whitespace outside double quotes. Quotes are kept on their token. */
function tokens(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

const unquoted = (token: string): string => token.replace(/"[^"]*"?/g, "");

/**
 * Why a `github-issue` rule query is unusable, or `[]`. Checked when rules
 * load, so a bad rule stops the daemon before any search runs.
 *
 * Boolean operators and parentheses are refused because the org scope is
 * appended to the query and must AND with all of it. `org:`, `user:` and
 * `owner:` are refused because scope comes from configuration; `repo:` may
 * narrow it. Anything asking for pull requests is refused.
 */
export function githubIssueQueryProblems(query: string): string[] {
  const problems: string[] = [];
  for (const token of tokens(query)) {
    const bare = unquoted(token);
    if (/[()]/.test(bare)) problems.push(`parentheses are not supported ("${token}")`);
    if (/^(AND|OR|NOT)$/.test(token)) problems.push(`boolean operator ${token} is not supported`);
    const q = /^(-?)([A-Za-z-]+):(.*)$/.exec(token);
    if (!q) continue;
    const [, neg, rawKey, rawValue] = q as unknown as [string, string, string, string];
    const key = rawKey.toLowerCase();
    const value = rawValue.replace(/^"|"$/g, "").toLowerCase();
    if (key === "org" || key === "user" || key === "owner") problems.push(`"${token}": scope comes from BUTCHR_GITHUB_ORGS; narrow with repo:owner/name`);
    if ((key === "is" || key === "type") && (value === "pr" || value === "pull-request")) problems.push(`"${token}": github-issue rules match issues, never pull requests`);
    if (key === "is" && value === "issue" && neg) problems.push(`"${token}": github-issue rules match issues, never pull requests`);
    if (key === "repo" && !neg && !repoQualifier(rawValue)) problems.push(`"${token}" must name owner/name`);
  }
  return problems;
}

function repoQualifier(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = value.toLowerCase().split("/");
  return owner && repo && !rest.length && isGithubOwner(owner) && isGithubRepo(repo) ? { owner, repo } : null;
}

/**
 * The query actually sent: the rule's query, `is:issue`, and its scope. With
 * `repo:` qualifiers the repos ARE the scope (each must be owned by a
 * configured org — GitHub ORs scope qualifiers, so adding `org:` too would
 * widen the search to the whole org); otherwise one `org:` per configured org.
 */
export function scopedIssueQuery(query: string, orgs: readonly string[]): string {
  const problems = githubIssueQueryProblems(query);
  if (problems.length) throw new Error(`github-issue query rejected: ${problems.join("; ")}`);
  const allowed = new Set(orgs.map((o) => o.toLowerCase()));
  if (!allowed.size) throw new Error("github-issue search needs BUTCHR_GITHUB_ORGS");
  const repos = tokens(query).flatMap((t) => {
    const m = /^repo:(.*)$/i.exec(t);
    return m ? [repoQualifier(m[1]!)!] : [];
  });
  for (const r of repos) if (!allowed.has(r.owner)) throw new Error(`github-issue query names repo:${r.owner}/${r.repo} outside BUTCHR_GITHUB_ORGS`);
  const scope = repos.length ? [] : [...allowed].map((o) => `org:${o}`);
  return [query.trim(), "is:issue", ...scope].join(" ");
}

interface SearchItem {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  state_reason?: unknown;
  type?: { name?: unknown } | null;
  labels?: Array<{ name?: unknown } | string>;
  comments?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  pull_request?: unknown;
}

/** One search item as an issue, or null for a pull request or anything malformed. */
export function mapGithubIssue(item: SearchItem): GithubIssue | null {
  if (item.pull_request !== undefined) return null;
  const repoUrl = typeof item.repository_url === "string" ? /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url) : null;
  if (!repoUrl || typeof item.number !== "number" || !Number.isInteger(item.number) || item.number < 1) return null;
  let ref: string;
  try { ref = formatGithubIssueRef({ owner: repoUrl[1]!, repo: repoUrl[2]!, number: item.number }); } catch { return null; }
  const [owner, rest] = ref.split("/") as [string, string];
  return {
    ref, owner, repo: rest.split("#")[0]!, number: item.number,
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    state: typeof item.state === "string" ? item.state : "unknown",
    stateReason: typeof item.state_reason === "string" ? item.state_reason : null,
    issueType: typeof item.type?.name === "string" ? item.type.name : null,
    labels: (item.labels ?? []).map((l) => (typeof l === "string" ? l : typeof l.name === "string" ? l.name : "")).filter(Boolean).sort(),
    comments: typeof item.comments === "number" ? item.comments : 0,
    updated: typeof item.updated_at === "string" ? item.updated_at : "",
    url: typeof item.html_url === "string" ? item.html_url : "",
  };
}

export interface GithubIssueClientDeps {
  fetchImpl: FetchLike;
  token: string;
  orgs: readonly string[];
  log?: (line: string) => void;
}

/** GitHub search returns at most 1000 results for any query. */
export const GITHUB_SEARCH_LIMIT = 1000;
const PAGE = 100;
const COMMENT_PAGE_LIMIT = 30;

export interface GithubIssueClient {
  /** Every issue a rule query matches, or a rejection — never a partial list. */
  searchAll(query: string): Promise<GithubIssue[]>;
  /** Every comment on one issue, oldest first. */
  comments(ref: GithubIssueRef): Promise<GithubComment[]>;
}

export function createGithubIssueClient(deps: GithubIssueClientDeps): GithubIssueClient {
  const allowed = new Set(deps.orgs.map((o) => o.toLowerCase()));
  const get = async (url: string, what: string): Promise<unknown> => {
    const res = await deps.fetchImpl(url, { headers: ghHeaders(deps.token) });
    if (!res.ok) throw new GithubHttpError(res.status, what);
    return res.json();
  };
  return {
    async searchAll(query) {
      // Created order, oldest first: new issues land on the last page, so paging
      // cannot skip an issue the way updated order can when one moves mid-read.
      const q = scopedIssueQuery(query, deps.orgs);
      const byRef = new Map<string, GithubIssue>();
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ q, sort: "created", order: "asc", per_page: String(PAGE), page: String(page) });
        const body = await get(`https://api.github.com/search/issues?${params}`, "issue search") as { total_count?: unknown; incomplete_results?: unknown; items?: unknown };
        if (typeof body.total_count !== "number" || !Array.isArray(body.items)) throw new Error("GitHub issue search returned an unexpected body");
        if (body.incomplete_results === true) throw new Error("GitHub issue search returned incomplete results");
        if (body.total_count > GITHUB_SEARCH_LIMIT) throw new Error(`GitHub issue search matched ${body.total_count} issues, over the ${GITHUB_SEARCH_LIMIT} it can list`);
        for (const item of body.items as SearchItem[]) {
          const issue = mapGithubIssue(item);
          if (!issue) continue;
          if (!allowed.has(issue.owner)) { deps.log?.(`[github-issue] dropped ${issue.ref}: owner outside BUTCHR_GITHUB_ORGS`); continue; }
          byRef.set(issue.ref, issue);
        }
        if (body.items.length < PAGE || page * PAGE >= body.total_count) break;
      }
      return [...byRef.values()];
    },
    async comments(ref) {
      const out: GithubComment[] = [];
      for (let page = 1; ; page++) {
        if (page > COMMENT_PAGE_LIMIT) throw new Error(`GitHub comments for ${formatGithubIssueRef(ref)} exceed ${COMMENT_PAGE_LIMIT * PAGE}`);
        const params = new URLSearchParams({ per_page: String(PAGE), page: String(page) });
        const body = await get(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?${params}`, "issue comments");
        if (!Array.isArray(body)) throw new Error("GitHub issue comments returned an unexpected body");
        for (const c of body as Array<Record<string, unknown>>) {
          out.push({
            id: String(c.id),
            author: typeof (c.user as { login?: unknown } | null)?.login === "string" ? (c.user as { login: string }).login : null,
            body: typeof c.body === "string" ? c.body : "",
            created: typeof c.created_at === "string" ? c.created_at : "",
            updated: typeof c.updated_at === "string" ? c.updated_at : "",
          });
        }
        if (body.length < PAGE) return out;
      }
    },
  };
}
