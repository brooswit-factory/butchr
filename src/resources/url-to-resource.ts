/**
 * FACTORY-339 (implementing FACTORY-335, epic FACTORY-330): a pure,
 * dependency-free-of-I/O mapping from a browser URL to at most one
 * `{ resourceProvider, resourceId }` — the identity half of "Cleavr" (a Chrome
 * extension that slides a Claude terminal in for a page IF Butchr is running
 * an agent on it). This module answers "what resource, if any, does this URL
 * name" ONLY; it never looks at the agent registry (`GET /resources/for-url`,
 * `src/resources/resource-lookup.ts`, does that half).
 *
 * `resourceProvider` here is `../rules/agent-key.ts`'s `ResourceProvider`
 * (`"jira-work"`, `"github-issue"`, `"github-pr"`, `"zendesk-ticket"`, ...) —
 * the vocabulary an AGENT KEY is actually built from — never
 * `resource-ref.ts`'s differently-named, differently-scoped
 * `ResourceRefProvider` (`"jira-work-item"`, no `github-pr`/`zendesk-ticket`
 * member at all). See that module's own header for the full naming trap.
 *
 * REUSE, NOT A SECOND SET OF PARSERS:
 * - Canonicalization of the URL itself (scheme, credential-rejection,
 *   lower-cased host, default-port/fragment stripping, trailing-slash
 *   normalization) is `webpage-ref.ts`'s `parseWebpageRef` — called exactly
 *   once, here, for every URL regardless of which provider (if any) it later
 *   matches. This is also why embedded credentials and non-`http(s)` schemes
 *   already resolve to "no resource" for every provider without a
 *   per-provider check: `parseWebpageRef` returns `null` for both, and
 *   `canonicalUrl: null` short-circuits before any provider match is even
 *   attempted.
 * - The Jira issue key itself is validated/case-folded by
 *   `jira-work-item-ref.ts`'s `parseJiraWorkItemRef` (which reuses
 *   `isIssueKey`, `id.ts`) — this module only locates the candidate
 *   substring inside the URL's path/query.
 * - GitHub issue/PR identity is `github-issue-ref.ts`'s own
 *   `githubIssueRefFromUrl`/`githubPrRefFromUrl` — unmodified, called as-is.
 * - The Zendesk ticket identity's SHAPE (`<subdomain>#<id>`) is
 *   `zendesk-ticket-ref.ts`'s `parseZendeskTicketRef`; only the ticket URL's
 *   OWN path form (`/agent/tickets/<id>`, `zendesk-ticket.ts`'s own `url`
 *   field) is new here, since no prior module parsed a Zendesk URL at all.
 *
 * STRICT HOST MATCHING, BY DESIGN (ticket requirement, not an oversight):
 * each provider is checked against THIS DAEMON'S OWN CONFIGURED site/
 * subdomain (`UrlToResourceDeps`), never a generic `*.atlassian.net` /
 * `*.zendesk.com` pattern — a caller on a DIFFERENT Jira or Zendesk instance
 * must resolve to no resource. `github.com` alone has no per-daemon config to
 * scope against (this codebase's GitHub integration is already
 * org-scoped elsewhere, not host-scoped), so it is the one provider checked
 * against a fixed literal host.
 *
 * A URL is classified into AT MOST ONE provider (`jira-work` checked first,
 * then GitHub, then Zendesk) purely because a canonical URL can only ever
 * match one host in the first place — the ordering has no observable effect
 * given that constraint, but is fixed here (rather than left to iteration
 * order) so a future reader doesn't have to wonder.
 *
 * JIRA URL FORMS (own judgment call, not a fact asserted about any live Jira
 * instance — verify these against the real product before trusting them
 * blind): the classic `/browse/<KEY>` view; the new-UI issue-detail form
 * whose path ends `.../issues/<KEY>` (e.g.
 * `/jira/software/c/projects/<PROJ>/issues/<KEY>`); and the board form that
 * carries the key in a `selectedIssue` query parameter (e.g.
 * `/jira/software/projects/<PROJ>/boards/<N>?selectedIssue=<KEY>`). All three
 * end up validated through the SAME `parseJiraWorkItemRef` call, so none of
 * them can produce a key `isIssueKey` itself would reject.
 */
import type { ResourceProvider } from "../rules/agent-key.js";
import { githubIssueRefFromUrl, githubPrRefFromUrl } from "./github-issue-ref.js";
import { formatGithubIssueRef } from "./github-issue-ref.js";
import { formatGithubPrRef } from "./github-pr-ref.js";
import { parseJiraWorkItemRef } from "./jira-work-item-ref.js";
import { isZendeskSubdomain, parseZendeskTicketRef } from "./zendesk-ticket-ref.js";
import { parseWebpageRef } from "./webpage-ref.js";

export interface ResourceIdentity {
  provider: ResourceProvider;
  id: string;
}

export interface UrlToResourceResult {
  /** The canonical form of `url` (see `webpage-ref.ts`), or `null` for anything that isn't a plain `http(s)` URL with no embedded credentials — never thrown. */
  canonicalUrl: string | null;
  /** `null` is a normal outcome ("not a Butchr resource"), never an error. */
  resource: ResourceIdentity | null;
}

export interface UrlToResourceDeps {
  /**
   * This daemon's own configured Jira site host (`Config.atlassian.site`'s
   * own host, e.g. `"acme.atlassian.net"`), LOWER-CASED by the caller — a
   * Jira URL on any other host, including a lookalike or another real
   * Atlassian site, resolves to no resource.
   */
  jiraHost: string;
  /**
   * This daemon's own configured Zendesk subdomain (`ZENDESK_SUBDOMAIN`,
   * `zendesk-ticket.ts`), when Zendesk is configured at all — `undefined`
   * (Zendesk unconfigured) means every Zendesk ticket URL resolves to no
   * resource, same as any other provider this daemon isn't set up for.
   */
  zendeskSubdomain?: string | undefined;
}

const GITHUB_HOST = "github.com";

/** `/browse/<key>` — the classic Jira issue view. Trailing slash already stripped by `parseWebpageRef`'s own canonicalization, so this need only match the bare form. */
const BROWSE_PATH_RE = /^\/browse\/([^/]+)$/;
/** The new-UI issue-detail form: any path ENDING `.../issues/<key>` (e.g. `/jira/software/c/projects/PROJ/issues/PROJ-1`). */
const ISSUE_DETAIL_PATH_RE = /\/issues\/([^/]+)$/;

/** The Jira issue key candidate this URL's path or `selectedIssue` query parameter names, or `null` for a URL naming none — validation/case-folding happens one level up, in `resolveJiraWorkItem`. */
function jiraKeyCandidate(u: URL): string | null {
  const browse = BROWSE_PATH_RE.exec(u.pathname);
  if (browse) return browse[1]!;
  const detail = ISSUE_DETAIL_PATH_RE.exec(u.pathname);
  if (detail) return detail[1]!;
  const selected = u.searchParams.get("selectedIssue");
  return selected ?? null;
}

function resolveJiraWorkItem(u: URL, jiraHost: string): ResourceIdentity | null {
  if (u.hostname !== jiraHost) return null;
  const candidate = jiraKeyCandidate(u);
  if (!candidate) return null;
  const ref = parseJiraWorkItemRef(candidate);
  return ref ? { provider: "jira-work", id: ref.key } : null;
}

function resolveGithub(u: URL, canonicalUrl: string): ResourceIdentity | null {
  if (u.hostname !== GITHUB_HOST) return null;
  const issue = githubIssueRefFromUrl(canonicalUrl);
  if (issue) return { provider: "github-issue", id: formatGithubIssueRef(issue) };
  const pr = githubPrRefFromUrl(canonicalUrl);
  return pr ? { provider: "github-pr", id: formatGithubPrRef(pr) } : null;
}

/** `/agent/tickets/<id>` — the only Zendesk ticket URL form this codebase itself ever generates (see `zendesk-ticket.ts`'s own `url` field). */
const ZENDESK_TICKET_PATH_RE = /^\/agent\/tickets\/([^/]+)$/;

function resolveZendeskTicket(u: URL, subdomain: string | undefined): ResourceIdentity | null {
  if (!subdomain || !isZendeskSubdomain(subdomain)) return null;
  if (u.hostname !== `${subdomain}.zendesk.com`) return null;
  const m = ZENDESK_TICKET_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const ref = parseZendeskTicketRef(`${subdomain}#${m[1]}`);
  return ref ? { provider: "zendesk-ticket", id: `${ref.subdomain}#${ref.id}` } : null;
}

/**
 * The whole mapping. Never throws: an unparseable string, a non-`http(s)`
 * scheme, or embedded credentials all fall out as `{ canonicalUrl: null,
 * resource: null }` via `parseWebpageRef`; anything parseable but matching no
 * configured provider is the equally normal `{ canonicalUrl, resource: null
 * }`.
 */
export function resolveUrlToResource(url: string, deps: UrlToResourceDeps): UrlToResourceResult {
  const webpage = parseWebpageRef(url);
  if (!webpage) return { canonicalUrl: null, resource: null };
  const canonicalUrl = webpage.url;
  // `webpage.url` is itself the output of `new URL(...).toString()` inside
  // `parseWebpageRef`, so re-parsing it here can never throw.
  const u = new URL(canonicalUrl);
  const resource =
    resolveJiraWorkItem(u, deps.jiraHost) ??
    resolveGithub(u, canonicalUrl) ??
    resolveZendeskTicket(u, deps.zendeskSubdomain);
  return { canonicalUrl, resource };
}
