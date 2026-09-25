/**
 * FACTORY-20/23: the comments capability — `readComments`/`addComment` over
 * any `CapabilityRef` (./capabilities.ts), gated by that module's declaration
 * mechanism so a caller never needs provider-specific knowledge: calling
 * either function on a provider that hasn't declared `comments` throws
 * `UnsupportedCapabilityError` before any provider-specific code runs.
 *
 * Implemented for `jira-work-item` ONLY, per this ticket's scope — reusing
 * `AtlassianClient`'s existing native comment methods (`allComments`/
 * `addComment`, src/atlassian/client.ts) exactly the way
 * `createJiraIdeaClient` (./jira-idea.ts) already reuses them for the
 * `jira-idea` provider: no duplicate Jira comment logic. Every other
 * provider — including `jira-idea`, which already has a *working* comment
 * path through its own client, and `zendesk-ticket`, which already has one
 * too (`ZendeskTicketClient.comments`/`addInternalNote`,
 * ./zendesk-ticket.ts) — declares `comments: false` in capabilities.ts's
 * matrix and is refused here identically to a provider with no comment code
 * at all. Wiring those existing, working implementations into this shared
 * interface is a follow-on story (FACTORY-21), out of scope here — see
 * docs/provider-capabilities.md's deviations section.
 */
import type { AtlassianClient } from "../atlassian/client.js";
import { formatJiraWorkItemRef } from "./jira-work-item-ref.js";
import { assertSupports, UnsupportedCapabilityError, type CapabilityRef } from "./capabilities.js";

/** The canonical, provider-agnostic comment shape every provider's comments would map onto. */
export interface Comment {
  id: string;
  /** The commenting account's email, or `null` when the provider didn't supply one (e.g. a deactivated/anonymized Jira user). */
  author: string | null;
  timestamp: string;
  body: string;
}

/** What `addComment` returns: enough to identify the comment just written, nothing provider-specific. */
export interface CommentRef {
  id: string;
}

type JiraCommentClient = Pick<AtlassianClient, "allComments" | "addComment">;

/**
 * Ordering and pagination, stated and documented as this ticket requires:
 * **oldest-first** (Jira's own `orderBy=created`), paged and capped entirely
 * by `AtlassianClient.allComments`'s existing behaviour (100 comments per
 * page, 1000-comment default cap) — no new paging logic here. A ticket with
 * more comments than the cap makes `allComments` throw rather than silently
 * truncating, so `readComments` never returns a partial list; it either
 * returns every comment or rejects.
 *
 * `ref.provider !== "jira-work-item"` is unreachable today (capabilities.ts's
 * matrix is the only provider with `comments: true`) but is checked
 * explicitly rather than assumed, both to narrow `ref`'s type for
 * `formatJiraWorkItemRef` and so this function stays correct on its own if
 * the matrix ever changes without this module changing in lockstep.
 */
export async function readComments(client: JiraCommentClient, ref: CapabilityRef): Promise<Comment[]> {
  assertSupports(ref, "comments");
  if (ref.provider !== "jira-work-item") throw new UnsupportedCapabilityError(ref.provider, "comments");
  const key = formatJiraWorkItemRef(ref);
  const raw = await client.allComments(key);
  return raw.map((c) => ({ id: c.id, author: c.authorEmail, timestamp: c.created, body: c.body }));
}

/** Posts one comment to `ref`. See `readComments`'s doc comment for why the provider check is repeated here. */
export async function addComment(client: JiraCommentClient, ref: CapabilityRef, body: string): Promise<CommentRef> {
  assertSupports(ref, "comments");
  if (ref.provider !== "jira-work-item") throw new UnsupportedCapabilityError(ref.provider, "comments");
  const key = formatJiraWorkItemRef(ref);
  const created = await client.addComment(key, body);
  return { id: created.id };
}
