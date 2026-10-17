/**
 * FACTORY-20/23 (mechanism), FACTORY-21 (comments extended to jira-idea,
 * github-issue, zendesk-ticket): capability declaration. Given a resource,
 * calling code asks which capability categories its provider actually
 * supports today — `capabilitiesOf`/`supports` — and gets a typed,
 * programmatically detectable failure (`UnsupportedCapabilityError`) rather
 * than a silent no-op or a faked result when it invokes one that isn't. See
 * docs/provider-capabilities.md for the full 10x7 inventory this table is
 * built from, file:function evidence per cell, and every deviation from the
 * original handoff proposal.
 *
 * ADDITIVE ONLY: this module does not rewrite resource-ref.ts,
 * issue.ts, or any provider's existing query/read/links code — it only
 * DECLARES which of that existing machinery is genuinely usable through a
 * uniform, provider-agnostic interface today. A capability lands `true`
 * below ONLY when a caller with zero provider-specific knowledge can use it
 * through a shared entry point; a "partial" implementation that only a
 * provider-aware caller could use correctly (e.g. confluence-page's
 * version-number-only read, jira-project's search-only lookup) is declared
 * `false` on purpose — see the doc for why each `false` cell isn't a gap to
 * close under this ticket.
 */
import type { ResourceRef } from "./resource-ref.js";
import type { JiraWorkItemRef } from "./jira-work-item-ref.js";
import type { ZendeskTicketRef } from "./zendesk-ticket-ref.js";
import type { TrelloCardRef } from "./trello-card-ref.js";

/**
 * The resource providers this codebase has any notion of today — a
 * superset of `ResourceRef`'s six kinds (`RESOURCE_REF_PROVIDERS`,
 * ./resource-ref.ts). `jira-idea`, `zendesk-ticket` and `trello-card` are
 * resource types this codebase has client/auth code for
 * (src/resources/jira-idea.ts, zendesk-ticket.ts, trello-card.ts) but are
 * deliberately excluded from `ResourceRef` itself — see that module's own
 * header. Capability declaration needs to answer for all of them, so this
 * list is its own, wider superset rather than an extension of
 * `RESOURCE_REF_PROVIDERS`. `trello-card` (FACTORY-1009) is additive
 * alongside the existing Jira/Confluence providers — no rule type, agent
 * staffing, or MCP tool wires it in yet; see trello-card.ts's own "Scope"
 * note.
 */
export const CAPABILITY_PROVIDERS = [
  "jira-work-item",
  "jira-project",
  "jira-idea",
  "confluence-page",
  "github-issue",
  "github-pr",
  "zendesk-ticket",
  "trello-card",
  "filesystem",
  "webpage",
] as const;
export type CapabilityProvider = (typeof CAPABILITY_PROVIDERS)[number];

/**
 * The capability categories this inventory covers. `catamorbiusPush`
 * (FACTORY-134, implementing story FACTORY-22) is the seventh: it declares
 * only that a Catamorbius CloudEvent → watch-key MAPPING exists for this
 * provider (`src/catamorbius/mapping.ts`) — NEVER that a Catamorbius
 * gateway is configured or reachable, which is a dynamic, per-deployment
 * fact this static table cannot and does not encode. See
 * docs/catamorbius-push.md for the mapping rules and docs/provider-
 * capabilities.md for this cell's own row in the inventory.
 */
export const CAPABILITIES = ["query", "read", "snapshot", "comments", "links", "createTask", "catamorbiusPush"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The minimal identity `capabilitiesOf`/`supports`/comments need: a provider
 * discriminant, the same shape callers already hold. A `ResourceRef` (the six
 * `resource-ref.ts` kinds) already satisfies this directly — no wrapping
 * required at the call site. `jira-idea` has no dedicated `-ref.ts` module
 * (its identity is a bare Jira issue key, structurally identical to
 * `JiraWorkItemRef` — the two are distinguishable only at runtime, by issue
 * type and project type, see `jiraIssueClass`, ./jira-idea.ts); `zendesk-ticket`
 * reuses its own existing `ZendeskTicketRef`.
 */
export type CapabilityRef =
  | ResourceRef
  | ({ provider: "jira-idea" } & JiraWorkItemRef)
  | ({ provider: "zendesk-ticket" } & ZendeskTicketRef)
  | ({ provider: "trello-card" } & TrelloCardRef);

/**
 * Thrown when a capability-gated invocation (today: `readComments`/
 * `addComment`, ./comments.ts) is asked to act on a provider that does not
 * support the requested capability. Distinguishable from a genuine bug via
 * `instanceof UnsupportedCapabilityError` or the `provider`/`capability`
 * fields — never a generic `Error`, never a silent no-op, never a faked
 * result.
 */
export class UnsupportedCapabilityError extends Error {
  readonly provider: CapabilityProvider;
  readonly capability: Capability;
  constructor(provider: CapabilityProvider, capability: Capability) {
    super(`${provider} does not support capability ${JSON.stringify(capability)}`);
    this.name = "UnsupportedCapabilityError";
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * The declaration table. See docs/provider-capabilities.md for the full
 * status (including "partial") and file:line evidence behind every cell —
 * this table only carries the boolean a caller can safely act on.
 */
// local/ui: `links` meant "can own or be the target of a butchr-managed
// link" for every ResourceRef kind. Managed links are gone, so it's true only
// for jira-work-item, whose own Jira issue links linked-change events read.
const MATRIX: Record<CapabilityProvider, Record<Capability, boolean>> = {
  "jira-work-item": { query: true, read: true, snapshot: false, comments: true, links: true, createTask: false, catamorbiusPush: true },
  "jira-project": { query: true, read: false, snapshot: false, comments: false, links: false, createTask: false, catamorbiusPush: false },
  "jira-idea": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: false },
  // FACTORY-998: `query` flipped true — a real provider/rule now exists
  // (src/rules/confluence-page-type.ts, `{"ancestor": "<page id>"}`), usable
  // by a caller with zero provider-specific knowledge the same way every
  // other `true` cell here is. `read` stays `false` on purpose: a bare
  // version-number read is not what this cell means (see the handoff doc's
  // own "partial implementation" carve-out this module's header cites) —
  // page CONTENT is read via `get_my_confluence_page`
  // (FACTORY-993/996, src/tools/defs.ts), a self-only verb with no
  // provider-agnostic entry point, not through a shared `read` capability.
  "confluence-page": { query: true, read: false, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: false },
  "github-issue": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: true },
  "github-pr": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: true },
  "zendesk-ticket": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: false },
  // FACTORY-1009: query/read/comments mirror zendesk-ticket's own row — a
  // real REST client exists for all three (trello-card.ts), reusable by a
  // zero-provider-knowledge caller through comments.ts the same way. `links`
  // stays false, same as zendesk-ticket's; no event-rules/poll wiring exists, so `snapshot`
  // is the plain "absent" case, not a flip under "The snapshot bar".
  "trello-card": { query: true, read: true, snapshot: false, comments: true, links: false, createTask: false, catamorbiusPush: false },
  filesystem: { query: true, read: false, snapshot: false, comments: false, links: false, createTask: false, catamorbiusPush: false },
  webpage: { query: false, read: false, snapshot: false, comments: false, links: false, createTask: false, catamorbiusPush: false },
};

/** Every capability `ref`'s provider truthfully supports today, in `CAPABILITIES` order. */
export function capabilitiesOf(ref: CapabilityRef): Capability[] {
  return CAPABILITIES.filter((c) => MATRIX[ref.provider][c]);
}

/** Whether `ref`'s provider supports `capability` today. */
export function supports(ref: CapabilityRef, capability: Capability): boolean {
  return MATRIX[ref.provider][capability];
}

/** Throws `UnsupportedCapabilityError` iff `!supports(ref, capability)` — the shared gate every capability-specific invocation calls first. */
export function assertSupports(ref: CapabilityRef, capability: Capability): void {
  if (!supports(ref, capability)) throw new UnsupportedCapabilityError(ref.provider, capability);
}
