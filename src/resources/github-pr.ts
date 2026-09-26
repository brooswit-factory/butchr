/**
 * FACTORY-57 (implementing FACTORY-56, epic FACTORY-55): the `github-pr`
 * resource provider's GitHub side — rule-query validation, org scoping, and
 * a REST client for pull requests and their (issue-style) comments. Deliberate
 * mirror of `./github-issue.ts`; see that module's own header for the shared
 * design this one repeats with PR/issue swapped, and `./github-pr-ref.ts`'s
 * header for exactly how the two providers avoid colliding on GitHub's
 * shared issue/PR number namespace.
 *
 * The ONE write is `addComment`, and it only ever lands on a pull request it
 * has just re-read as a pull request (not a plain issue) inside the
 * configured orgs. Nothing here creates, edits, merges, closes, reviews, or
 * labels anything — this provider is read + comment only, exactly like
 * `github-issue`.
 *
 * Auth and scope reuse `github-issue.ts`'s own configuration (src/config/config.ts
 * `github`): the token from `GITHUB_TOKEN_FILE`, and `BUTCHR_GITHUB_ORGS` as
 * the only owners a query may reach — see `.env.example`'s own
 * `GITHUB_TOKEN_FILE` comment block for the finding that one token covers
 * both providers and what scope it needs.
 *
 * Issues are never pull requests here: every search adds `is:pr`, queries
 * that ask for issues are rejected at rule-load time, and any search result
 * that does NOT carry a `pull_request` field (i.e. is a plain issue) is
 * dropped regardless — the exact mirror of `github-issue.ts`'s own
 * `is:issue` triple-enforcement, with the roles reversed.
 */
import { ghHeaders, type FetchLike } from "../labels/pr.js";
import { GithubHttpError } from "./github-issue.js";
import { isGithubOwner, isGithubRepo } from "./github-issue-ref.js";
import { formatGithubPrRef, type GithubPrRef } from "./github-pr-ref.js";

export { GithubHttpError };

export interface GithubPr {
  /** Canonical `owner/repo#number` — the resource id (shared shape with `github-issue`; see `github-pr-ref.ts`'s header). */
  ref: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  /** GitHub's own PR state: `"open"` or `"closed"` (a merged PR reads `"closed"` — see `merged` to tell the two apart). */
  state: string;
  /** True once the PR has been merged; a merged PR is always `state: "closed"` too, but not every closed PR is merged. */
  merged: boolean;
  draft: boolean;
  labels: string[];
  /** GitHub's comment count (issue-style conversation comments), as returned with the PR. */
  comments: number;
  updated: string;
  url: string;
}

export interface GithubComment { id: string; author: string | null; body: string; created: string; updated: string }

/** Split on whitespace outside double quotes. Quotes are kept on their token. */
function tokens(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

const unquoted = (token: string): string => token.replace(/"[^"]*"?/g, "");

/**
 * Why a `github-pr` rule query is unusable, or `[]`. Checked when rules
 * load, so a bad rule stops the daemon before any search runs. Mirror of
 * `github-issue.ts`'s `githubIssueQueryProblems`, roles reversed: anything
 * asking for plain issues is refused here, exactly as anything asking for
 * pull requests is refused there.
 */
export function githubPrQueryProblems(query: string): string[] {
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
    if ((key === "is" || key === "type") && (value === "issue")) problems.push(`"${token}": github-pr rules match pull requests, never issues`);
    if (key === "is" && value === "pr" && neg) problems.push(`"${token}": github-pr rules match pull requests, never issues`);
    if (key === "repo" && !neg && !repoQualifier(rawValue)) problems.push(`"${token}" must name owner/name`);
  }
  return problems;
}

function repoQualifier(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = value.toLowerCase().split("/");
  return owner && repo && !rest.length && isGithubOwner(owner) && isGithubRepo(repo) ? { owner, repo } : null;
}

/**
 * The query actually sent: the rule's query, `is:pr`, and its scope. With
 * `repo:` qualifiers the repos ARE the scope (each must be owned by a
 * configured org — GitHub ORs scope qualifiers, so adding `org:` too would
 * widen the search to the whole org); otherwise one `org:` per configured org.
 */
export function scopedPrQuery(query: string, orgs: readonly string[]): string {
  const problems = githubPrQueryProblems(query);
  if (problems.length) throw new Error(`github-pr query rejected: ${problems.join("; ")}`);
  const allowed = new Set(orgs.map((o) => o.toLowerCase()));
  if (!allowed.size) throw new Error("github-pr search needs BUTCHR_GITHUB_ORGS");
  const repos = tokens(query).flatMap((t) => {
    const m = /^repo:(.*)$/i.exec(t);
    return m ? [repoQualifier(m[1]!)!] : [];
  });
  for (const r of repos) if (!allowed.has(r.owner)) throw new Error(`github-pr query names repo:${r.owner}/${r.repo} outside BUTCHR_GITHUB_ORGS`);
  const scope = repos.length ? [] : [...allowed].map((o) => `org:${o}`);
  return [query.trim(), "is:pr", ...scope].join(" ");
}

interface SearchItem {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  draft?: unknown;
  labels?: Array<{ name?: unknown } | string>;
  comments?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  /** Present (an object, possibly with `merged_at: null`) iff GitHub's search API considers this item a pull request. */
  pull_request?: { merged_at?: unknown } | null;
}

/** One search item as a pull request, or null for a plain issue or anything malformed. */
export function mapGithubPr(item: SearchItem): GithubPr | null {
  if (item.pull_request === undefined || item.pull_request === null) return null;
  const repoUrl = typeof item.repository_url === "string" ? /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url) : null;
  if (!repoUrl || typeof item.number !== "number" || !Number.isInteger(item.number) || item.number < 1) return null;
  let ref: string;
  try { ref = formatGithubPrRef({ owner: repoUrl[1]!, repo: repoUrl[2]!, number: item.number }); } catch { return null; }
  const [owner, rest] = ref.split("/") as [string, string];
  return {
    ref, owner, repo: rest.split("#")[0]!, number: item.number,
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    state: typeof item.state === "string" ? item.state : "unknown",
    merged: typeof item.pull_request.merged_at === "string",
    draft: typeof item.draft === "boolean" ? item.draft : false,
    labels: (item.labels ?? []).map((l) => (typeof l === "string" ? l : typeof l.name === "string" ? l.name : "")).filter(Boolean).sort(),
    comments: typeof item.comments === "number" ? item.comments : 0,
    updated: typeof item.updated_at === "string" ? item.updated_at : "",
    url: typeof item.html_url === "string" ? item.html_url : "",
  };
}

/** The `GET /pulls/<n>` response shape — DIFFERENT from `SearchItem` above (a direct pull-request read, not a search hit): `merged` sits at the top level, never nested under a `pull_request` field. */
interface PullPayload {
  title?: unknown;
  body?: unknown;
  state?: unknown;
  merged?: unknown;
  draft?: unknown;
  labels?: Array<{ name?: unknown } | string>;
  comments?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
}

/** `ref` is already known (and already scope-checked) by the caller — this only maps the body's OWN fields, never re-derives owner/repo/number from it. */
function mapGithubPrFromPull(ref: GithubPrRef, item: PullPayload): GithubPr {
  const canonical = formatGithubPrRef(ref);
  return {
    ref: canonical, owner: ref.owner.toLowerCase(), repo: ref.repo.toLowerCase(), number: ref.number,
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    state: typeof item.state === "string" ? item.state : "unknown",
    merged: item.merged === true,
    draft: typeof item.draft === "boolean" ? item.draft : false,
    labels: (item.labels ?? []).map((l) => (typeof l === "string" ? l : typeof l.name === "string" ? l.name : "")).filter(Boolean).sort(),
    comments: typeof item.comments === "number" ? item.comments : 0,
    updated: typeof item.updated_at === "string" ? item.updated_at : "",
    url: typeof item.html_url === "string" ? item.html_url : "",
  };
}

export interface GithubPrClientDeps {
  fetchImpl: FetchLike;
  token: string;
  orgs: readonly string[];
  log?: (line: string) => void;
}

/** GitHub search returns at most 1000 results for any query — same cap `github-issue.ts` enforces. */
export const GITHUB_PR_SEARCH_LIMIT = 1000;
const PAGE = 100;
const COMMENT_PAGE_LIMIT = 30;

export interface GithubPrClient {
  /** Every pull request a rule query matches, or a rejection — never a partial list. */
  searchAll(query: string): Promise<GithubPr[]>;
  /** Every (issue-style, conversation) comment on one pull request, oldest first. */
  comments(ref: GithubPrRef): Promise<GithubComment[]>;
  /**
   * One pull request, re-read by number via `/pulls/<n>` — an endpoint that
   * 404s outright for a plain issue number, so (unlike `github-issue`'s
   * `/issues/<n>`, which serves both and must check a `pull_request` field)
   * no separate "is this really a PR" check is needed here. Rejects an
   * owner outside the configured orgs.
   */
  get(ref: GithubPrRef): Promise<GithubPr>;
  /** Post a comment after `get` confirms the target; resolves the new comment. */
  addComment(ref: GithubPrRef, body: string): Promise<GithubComment>;
}

export function createGithubPrClient(deps: GithubPrClientDeps): GithubPrClient {
  const allowed = new Set(deps.orgs.map((o) => o.toLowerCase()));
  const get = async (url: string, what: string): Promise<unknown> => {
    const res = await deps.fetchImpl(url, { headers: ghHeaders(deps.token) });
    if (!res.ok) throw new GithubHttpError(res.status, what);
    return res.json();
  };
  const pullUrl = (ref: GithubPrRef) => `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  // The issue-style comments endpoint also serves a pull request's own
  // conversation comments (a PR *is* an issue, under GitHub's data model) —
  // reused deliberately rather than the separate review-comments endpoint,
  // which is a different, diff-anchored concept this provider does not read.
  const commentsUrl = (ref: GithubPrRef) => `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`;
  const getPr = async (ref: GithubPrRef): Promise<GithubPr> => {
    const want = formatGithubPrRef(ref);
    if (!allowed.has(ref.owner.toLowerCase())) throw new Error(`${want} is outside BUTCHR_GITHUB_ORGS`);
    const item = await get(pullUrl(ref), "pull request read") as PullPayload | null;
    if (!item || typeof item !== "object") throw new Error(`GitHub pull request read for ${want} returned an unexpected body`);
    return mapGithubPrFromPull(ref, item);
  };
  return {
    get: getPr,
    async addComment(ref, body) {
      await getPr(ref);
      const res = await deps.fetchImpl(commentsUrl(ref), {
        method: "POST",
        headers: { ...ghHeaders(deps.token), "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new GithubHttpError(res.status, "pull request comment");
      return mapComment(await res.json() as Record<string, unknown>);
    },
    async searchAll(query) {
      // Created order, oldest first — same reasoning as github-issue.ts's
      // searchAll: new PRs land on the last page, so paging cannot skip one
      // the way updated order can when a PR moves mid-read.
      const q = scopedPrQuery(query, deps.orgs);
      const byRef = new Map<string, GithubPr>();
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ q, sort: "created", order: "asc", per_page: String(PAGE), page: String(page) });
        const body = await get(`https://api.github.com/search/issues?${params}`, "pull request search") as { total_count?: unknown; incomplete_results?: unknown; items?: unknown };
        if (typeof body.total_count !== "number" || !Array.isArray(body.items)) throw new Error("GitHub pull request search returned an unexpected body");
        if (body.incomplete_results === true) throw new Error("GitHub pull request search returned incomplete results");
        if (body.total_count > GITHUB_PR_SEARCH_LIMIT) throw new Error(`GitHub pull request search matched ${body.total_count} pull requests, over the ${GITHUB_PR_SEARCH_LIMIT} it can list`);
        for (const item of body.items as SearchItem[]) {
          const pr = mapGithubPr(item);
          if (!pr) continue;
          if (!allowed.has(pr.owner)) { deps.log?.(`[github-pr] dropped ${pr.ref}: owner outside BUTCHR_GITHUB_ORGS`); continue; }
          byRef.set(pr.ref, pr);
        }
        if (body.items.length < PAGE || page * PAGE >= body.total_count) break;
      }
      return [...byRef.values()];
    },
    async comments(ref) {
      const out: GithubComment[] = [];
      for (let page = 1; ; page++) {
        if (page > COMMENT_PAGE_LIMIT) throw new Error(`GitHub comments for ${formatGithubPrRef(ref)} exceed ${COMMENT_PAGE_LIMIT * PAGE}`);
        const params = new URLSearchParams({ per_page: String(PAGE), page: String(page) });
        const body = await get(`${commentsUrl(ref)}?${params}`, "pull request comments");
        if (!Array.isArray(body)) throw new Error("GitHub pull request comments returned an unexpected body");
        for (const c of body as Array<Record<string, unknown>>) out.push(mapComment(c));
        if (body.length < PAGE) return out;
      }
    },
  };
}

function mapComment(c: Record<string, unknown>): GithubComment {
  return {
    id: String(c.id),
    author: typeof (c.user as { login?: unknown } | null)?.login === "string" ? (c.user as { login: string }).login : null,
    body: typeof c.body === "string" ? c.body : "",
    created: typeof c.created_at === "string" ? c.created_at : "",
    updated: typeof c.updated_at === "string" ? c.updated_at : "",
  };
}
