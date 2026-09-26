/**
 * FACTORY-20/23/21: the comments capability — `readComments`/`addComment` over
 * any `CapabilityRef` (./capabilities.ts), gated by that module's declaration
 * mechanism so a caller never needs provider-specific knowledge: calling
 * either function on a provider that hasn't declared `comments` throws
 * `UnsupportedCapabilityError` before any provider-specific code runs.
 *
 * Implemented for FIVE providers today — `jira-work-item`, `jira-idea`,
 * `github-issue`, `zendesk-ticket`, `confluence-page` — each reusing that
 * provider's own existing native comment methods, never a reimplementation:
 *   - `jira-work-item`: `AtlassianClient.allComments`/`addComment`
 *     (src/atlassian/client.ts).
 *   - `jira-idea`: `JiraIdeaClient.comments`/`.addComment` (./jira-idea.ts),
 *     which itself delegates `comments` straight to
 *     `AtlassianClient.allComments` and re-verifies (`get()`) the issue is
 *     still a proven idea before every `addComment` write.
 *   - `github-issue`: `GithubIssueClient.comments`/`.addComment`
 *     (./github-issue.ts), which re-reads the issue (`get()`) before every
 *     write.
 *   - `zendesk-ticket`: `ZendeskTicketClient.comments`/`addInternalNote`
 *     (./zendesk-ticket.ts) — the write is PRIVATE-NOTE-ONLY; there is no
 *     public-reply path here or in the client it calls.
 *   - `confluence-page` (FACTORY-29/31): `AtlassianOps.getPageComments`/
 *     `commentOnPage` (src/tools/atlassian.ts, implemented in
 *     src/tools/atlassian-real.ts) over Confluence FOOTER comments only —
 *     inline comments are a separate Confluence concept, not read or written
 *     here. Two asymmetric design decisions, both recorded in full in
 *     docs/provider-capabilities.md:
 *       1. **Body format is asymmetric by direction.** `addComment`'s `body`
 *          is PLAIN TEXT — this module converts it to storage-format XHTML
 *          itself (`plainTextToStorageXHTML` below), so a caller never needs
 *          to know Confluence's storage representation, matching every other
 *          provider's `addComment(body: string)`. `readComments`' returned
 *          `Comment.body`, by contrast, is whatever `getPageComments` handed
 *          back: storage-format XHTML AS-IS, never converted to plain text
 *          (lossy, and a second body dialect to maintain). A caller that
 *          needs to POST raw storage-format XHTML (not plain text) must go
 *          around this interface and call `AtlassianOps.commentOnPage`
 *          directly — not supported through `addComment`.
 *       2. **Ordering is sorted here, not server-side.** See the
 *          ordering/pagination doc block on `readComments` below for why.
 * `jira-project`, `filesystem` and `webpage` declare `comments: false` in
 * capabilities.ts's matrix and are refused here identically to a provider
 * with no comment code at all — see docs/provider-capabilities.md for why
 * each of those is unsupported (one of them for reasons other than "nobody's
 * wired it in yet").
 *
 * CLIENT ARGUMENT SHAPE (FACTORY-21 design decision, recorded here and in
 * the doc): the original `jira-work-item`-only signature took a single
 * Jira-typed `client` — that shape cannot name four different providers'
 * clients at once. `CommentClients` below is a per-provider BAG, one
 * optional field per provider this module knows how to talk to, keyed by
 * `CapabilityProvider` string so a call site only ever has to supply the
 * client(s) it actually has. `readComments`/`addComment` switch on
 * `ref.provider`, pull the matching field out of the bag, and throw a plain
 * `Error` (not `UnsupportedCapabilityError` — the capability genuinely is
 * supported; the caller just didn't hand over a client for it) if that
 * field is missing. The `jira-work-item` field's type
 * (`Pick<AtlassianClient, "allComments" | "addComment">`) is exactly the
 * type the old single-argument signature accepted, so every existing
 * `jira-work-item` caller keeps working — it now just gets wrapped in
 * `{ "jira-work-item": client }` at the call site instead of passed bare.
 */
import type { AtlassianClient } from "../atlassian/client.js";
import type { JiraComment } from "../atlassian/types.js";
import type { AtlassianOps } from "../tools/atlassian.js";
import type { GithubComment, GithubIssueClient } from "./github-issue.js";
import type { JiraIdeaClient } from "./jira-idea.js";
import type { ZendeskComment, ZendeskTicketClient } from "./zendesk-ticket.js";
import { formatConfluencePageRef } from "./confluence-page-ref.js";
import { formatJiraWorkItemRef } from "./jira-work-item-ref.js";
import { formatZendeskTicketRef } from "./zendesk-ticket-ref.js";
import { assertSupports, UnsupportedCapabilityError, type CapabilityProvider, type CapabilityRef } from "./capabilities.js";

/** The canonical, provider-agnostic comment shape every provider's comments map onto. */
export interface Comment {
  id: string;
  /**
   * The commenting account's identity as the provider best exposes it, or
   * `null` when the provider didn't supply one — a Jira/Jira-idea email
   * (`author: string | null` on `JiraComment`), a GitHub login, or a
   * Zendesk numeric author id STRINGIFIED (Zendesk's comment payload
   * carries only `author_id`, never an email or display name — see
   * `ZendeskComment.authorId`, ./zendesk-ticket.ts). Never fabricated when
   * the provider returned nothing.
   */
  author: string | null;
  timestamp: string;
  body: string;
}

/** What `addComment` returns: enough to identify the comment just written, nothing provider-specific. */
export interface CommentRef {
  id: string;
}

type JiraCommentClient = Pick<AtlassianClient, "allComments" | "addComment">;
type JiraIdeaCommentClient = Pick<JiraIdeaClient, "comments" | "addComment">;
type GithubIssueCommentClient = Pick<GithubIssueClient, "comments" | "addComment">;
type ZendeskTicketCommentClient = Pick<ZendeskTicketClient, "comments" | "addInternalNote">;
/**
 * A `Pick` of `AtlassianOps` (src/tools/atlassian.ts), not a bespoke
 * `confluence-page` client wrapper — this daemon's `AtlassianOps`-typed
 * dependency already reaches other `src/resources/` modules directly
 * (`jira-project-link-store.ts`, `project.ts`), so this is existing
 * precedent, not a new layering violation. Picking just the two methods this
 * module needs keeps the surface minimal and lets tests pass a two-method
 * fake, same discipline as every other `*CommentClient` alias above.
 */
type ConfluencePageCommentClient = Pick<AtlassianOps, "commentOnPage" | "getPageComments">;

/**
 * The per-provider client bag `readComments`/`addComment` draw from — see
 * this module's header for why this shape replaced the single Jira-typed
 * argument. Every field is optional: a caller supplies only the client(s)
 * for the provider(s) it actually calls with.
 */
export interface CommentClients {
  "jira-work-item"?: JiraCommentClient;
  "jira-idea"?: JiraIdeaCommentClient;
  "github-issue"?: GithubIssueCommentClient;
  "zendesk-ticket"?: ZendeskTicketCommentClient;
  "confluence-page"?: ConfluencePageCommentClient;
}

function requireClient<T>(client: T | undefined, provider: CapabilityProvider): T {
  if (!client) throw new Error(`comments: no ${provider} client was provided in the CommentClients bag`);
  return client;
}

const mapJiraComment = (c: JiraComment): Comment => ({ id: c.id, author: c.authorEmail, timestamp: c.created, body: c.body });
const mapGithubComment = (c: GithubComment): Comment => ({ id: c.id, author: c.author, timestamp: c.created, body: c.body });
const mapZendeskComment = (c: ZendeskComment): Comment => ({ id: c.id, author: c.authorId !== null ? String(c.authorId) : null, timestamp: c.created, body: c.body });

/**
 * `AtlassianOps.getPageComments`' own per-comment shape, verified against
 * `atlassian-real.ts`: `body` is the comment's storage-format XHTML
 * (`c?.body?.storage?.value ?? ""` — an empty string, never `undefined`, when
 * the underlying read carried no body at all); `author`/`created` are
 * genuinely OPTIONAL (`undefined`, never a placeholder) when Confluence's own
 * response didn't carry them. `author: c.author ?? null` — `Comment.author`
 * is `string | null`, never `undefined`, same convention every other mapper
 * above already follows. `timestamp: c.created ?? ""` (DECIDED, FACTORY-31):
 * `Comment.timestamp` is a plain, non-optional `string`; rather than reject a
 * comment for lacking a `created` (a real Confluence possibility, not a
 * hypothetical — see `getPageComments`' own doc comment on `AtlassianOps`),
 * an absent timestamp maps to `""`. A caller comparing timestamps for
 * equality/freshness must treat `""` as "unknown", not as an epoch value —
 * this is a lossless decision only insofar as ordering has ALREADY happened
 * before this mapping runs (`compareConfluenceCommentsByCreatedAscending`
 * below sorts on the original `created?: string`, undefined-aware, never on
 * this post-mapping `""`).
 */
const mapConfluenceComment = (c: { id: string; body: string; author?: string; created?: string }): Comment => ({
  id: c.id,
  author: c.author ?? null,
  timestamp: c.created ?? "",
  body: c.body,
});

/**
 * `getPageComments` deliberately requests no server-side `sort` (see that
 * op's own doc comment on `AtlassianOps`) — every OTHER provider in this
 * module is oldest-first by construction (their own native client already
 * sorts), so confluence-page's `readComments` must sort client-side to keep
 * the same documented contract. Comments with no `created` (a real, optional
 * field) sort AFTER every dated comment, in their original relative order
 * among themselves (DECIDED, FACTORY-31: "no timestamp" reads as "unknown
 * position", not as "oldest" or "newest" — sorting them to the front would
 * claim a false ordering fact just as much as sorting them mixed in by
 * insertion order would). `Array.prototype.sort` is spec-guaranteed stable
 * (ECMA-262 since ES2019), which this comparator's "keep relative order
 * among undated comments" claim depends on.
 */
function compareConfluenceCommentsByCreatedAscending(a: { created?: string }, b: { created?: string }): number {
  if (a.created === undefined && b.created === undefined) return 0;
  if (a.created === undefined) return 1;
  if (b.created === undefined) return -1;
  return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
}

/**
 * `addComment`'s plain-text -> storage-XHTML conversion (design decision 1,
 * docs/provider-capabilities.md) — the SIMPLEST correct conversion, not a
 * general Markdown-to-XHTML engine: HTML-escape `& < > " '` (in that order,
 * `&` first, so escaping the other four never double-escapes their own
 * ampersands), then split on runs of two-or-more newlines into paragraphs
 * (Confluence storage format has no bare text node at the top level the way
 * plain HTML would tolerate — every visible line must sit inside a block
 * element), wrapping each in `<p>…</p>` with remaining single newlines inside
 * a paragraph turned into `<br/>`. A wholly empty input produces a single
 * empty `<p></p>` (Confluence renders it as a blank line) rather than no
 * content at all — never THROWS on an empty body, since there is no invalid
 * plain-text input this function cannot represent.
 */
function escapeStorageXHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function plainTextToStorageXHTML(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeStorageXHTML(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

/**
 * Ordering and pagination, stated and documented as this ticket requires —
 * every provider below is **oldest-first, returns everything or rejects,
 * never silently truncates**, all pre-existing behaviour reused unchanged:
 *   - `jira-work-item`/`jira-idea`: Jira's own `orderBy=created`, paged 100
 *     at a time, capped at 1000 (`AtlassianClient.allComments`; `jira-idea`
 *     calls the exact same function).
 *   - `github-issue`: GitHub's issue-comments endpoint has no `sort`
 *     parameter and returns comments in creation order by default; paged
 *     100 at a time, capped at 3000 (`GithubIssueClient.comments`).
 *   - `zendesk-ticket`: `sort_order: asc`, cursor-paginated 100 at a time,
 *     capped at 3000 (`ZendeskTicketClient.comments`).
 *   - `confluence-page` (FACTORY-31): oldest-first, but SORTED HERE, not by
 *     the server — `AtlassianOps.getPageComments` deliberately requests no
 *     `sort` (its own doc comment on `AtlassianOps` explains why: the spec
 *     documents no default, and that op's other existing callers already
 *     compare ids as a SET rather than relying on any order). Paginated to
 *     exhaustion by that op itself, page size 250, throwing rather than
 *     returning a partial list on a malformed/never-terminating cursor (see
 *     `MAX_COMMENT_PAGES` in atlassian-real.ts) — this module adds no new
 *     pagination logic, only the client-side `.sort()` the other four
 *     providers get for free from their own native client. Cost, stated
 *     plainly: no sort is requested from the server, so every page must be
 *     fetched before the sort can run — there is no way to return an early
 *     partial ordering for a page with many comments.
 */
export async function readComments(clients: CommentClients, ref: CapabilityRef): Promise<Comment[]> {
  assertSupports(ref, "comments");
  switch (ref.provider) {
    case "jira-work-item": {
      const client = requireClient(clients["jira-work-item"], ref.provider);
      const raw = await client.allComments(formatJiraWorkItemRef(ref));
      return raw.map(mapJiraComment);
    }
    case "jira-idea": {
      const client = requireClient(clients["jira-idea"], ref.provider);
      const raw = await client.comments(formatJiraWorkItemRef(ref));
      return raw.map(mapJiraComment);
    }
    case "github-issue": {
      const client = requireClient(clients["github-issue"], ref.provider);
      const { owner, repo, number } = ref;
      const raw = await client.comments({ owner, repo, number });
      return raw.map(mapGithubComment);
    }
    case "zendesk-ticket": {
      const client = requireClient(clients["zendesk-ticket"], ref.provider);
      const { subdomain, id } = ref;
      const raw = await client.comments({ subdomain, id });
      return raw.map(mapZendeskComment);
    }
    case "confluence-page": {
      const client = requireClient(clients["confluence-page"], ref.provider);
      const pageId = formatConfluencePageRef(ref);
      const raw = await client.getPageComments(pageId);
      return [...raw.results].sort(compareConfluenceCommentsByCreatedAscending).map(mapConfluenceComment);
    }
    default:
      // Unreachable today (assertSupports above already refused every other
      // provider) — checked explicitly, not assumed, so this stays correct
      // on its own if the matrix ever changes without this module changing
      // in lockstep. See comments.test.ts's mirror of this reasoning.
      throw new UnsupportedCapabilityError(ref.provider, "comments");
  }
}

/**
 * Posts one comment to `ref`. See `readComments`'s doc comment for pagination
 * (irrelevant here) and this module's header for per-provider write
 * semantics — in particular `zendesk-ticket`'s write is PRIVATE-NOTE-ONLY.
 */
export async function addComment(clients: CommentClients, ref: CapabilityRef, body: string): Promise<CommentRef> {
  assertSupports(ref, "comments");
  switch (ref.provider) {
    case "jira-work-item": {
      const client = requireClient(clients["jira-work-item"], ref.provider);
      const created = await client.addComment(formatJiraWorkItemRef(ref), body);
      return { id: created.id };
    }
    case "jira-idea": {
      const client = requireClient(clients["jira-idea"], ref.provider);
      const created = await client.addComment(formatJiraWorkItemRef(ref), body);
      return { id: created.id };
    }
    case "github-issue": {
      const client = requireClient(clients["github-issue"], ref.provider);
      const { owner, repo, number } = ref;
      const created = await client.addComment({ owner, repo, number }, body);
      return { id: created.id };
    }
    case "zendesk-ticket": {
      const client = requireClient(clients["zendesk-ticket"], ref.provider);
      const { subdomain, id } = ref;
      const result = await client.addInternalNote({ subdomain, id }, body);
      // addInternalNote's own id can be null (its audit didn't carry one, see
      // ./zendesk-ticket.ts and its test's "silent audit" case) — CommentRef.id
      // is a plain string, so a null id here is a rejection, not a faked value.
      // The note has ALREADY BEEN POSTED at this point (addInternalNote's write
      // happened; only its id came back unconfirmed) — the message says so
      // explicitly so a caller that retries on rejection doesn't post a duplicate.
      if (result.id === null) throw new Error(`zendesk-ticket addInternalNote for ${formatZendeskTicketRef({ subdomain, id })} WAS posted, but its id could not be confirmed (Zendesk's audit didn't carry one) — do not retry, it would duplicate the note`);
      return { id: result.id };
    }
    case "confluence-page": {
      const client = requireClient(clients["confluence-page"], ref.provider);
      const pageId = formatConfluencePageRef(ref);
      const posted = await client.commentOnPage(pageId, plainTextToStorageXHTML(body));
      // `commentOnPage`'s declared return is `Promise<unknown>` — verified
      // against confluence.js 3.2.0's own `FooterCommentSchema` (the schema
      // `createFooterComment` parses its response through): `id` there is
      // `z.string().optional()`, not guaranteed by the LIBRARY'S OWN contract
      // even though a real 201 is expected to carry one. Never faked: same
      // honest-rejection precedent as zendesk-ticket's null-id case above —
      // the comment WAS posted (this call already succeeded) by the time an
      // unusable id is discovered, so the thrown message says so explicitly
      // and tells the caller not to retry.
      const rawId = (posted as { id?: unknown } | null | undefined)?.id;
      if (typeof rawId !== "string" || rawId.length === 0) {
        throw new Error(`confluence-page commentOnPage for page ${pageId} WAS posted, but its id could not be confirmed (the response carried no usable id) — do not retry, it would duplicate the comment`);
      }
      return { id: rawId };
    }
    default:
      throw new UnsupportedCapabilityError(ref.provider, "comments");
  }
}
