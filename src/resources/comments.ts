/**
 * FACTORY-20/23/21: the comments capability — `readComments`/`addComment` over
 * any `CapabilityRef` (./capabilities.ts), gated by that module's declaration
 * mechanism so a caller never needs provider-specific knowledge: calling
 * either function on a provider that hasn't declared `comments` throws
 * `UnsupportedCapabilityError` before any provider-specific code runs.
 *
 * Implemented for FOUR providers today — `jira-work-item`, `jira-idea`,
 * `github-issue`, `zendesk-ticket` — each reusing that provider's own
 * existing native comment methods, never a reimplementation:
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
 * `jira-project`, `confluence-page`, `filesystem` and `webpage` declare
 * `comments: false` in capabilities.ts's matrix and are refused here
 * identically to a provider with no comment code at all — see
 * docs/provider-capabilities.md for why each of those is unsupported (a
 * couple of them for reasons other than "nobody's wired it in yet").
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
import type { GithubComment, GithubIssueClient } from "./github-issue.js";
import type { JiraIdeaClient } from "./jira-idea.js";
import type { ZendeskComment, ZendeskTicketClient } from "./zendesk-ticket.js";
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
}

function requireClient<T>(client: T | undefined, provider: CapabilityProvider): T {
  if (!client) throw new Error(`comments: no ${provider} client was provided in the CommentClients bag`);
  return client;
}

const mapJiraComment = (c: JiraComment): Comment => ({ id: c.id, author: c.authorEmail, timestamp: c.created, body: c.body });
const mapGithubComment = (c: GithubComment): Comment => ({ id: c.id, author: c.author, timestamp: c.created, body: c.body });
const mapZendeskComment = (c: ZendeskComment): Comment => ({ id: c.id, author: c.authorId !== null ? String(c.authorId) : null, timestamp: c.created, body: c.body });

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
    default:
      throw new UnsupportedCapabilityError(ref.provider, "comments");
  }
}
