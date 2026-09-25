/**
 * FACTORY-20/23: capability declaration. Given a resource, calling code asks
 * which capability categories its provider actually supports today —
 * `capabilitiesOf`/`supports` — and gets a typed, programmatically
 * detectable failure (`UnsupportedCapabilityError`) rather than a silent
 * no-op or a faked result when it invokes one that isn't. See
 * docs/provider-capabilities.md for the full 8x6 inventory this table is
 * built from, file:function evidence per cell, and every deviation from the
 * original handoff proposal.
 *
 * ADDITIVE ONLY: this module does not rewrite resource-ref.ts, link-store.ts,
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

/**
 * The eight resource providers this codebase has any notion of today — a
 * superset of `ResourceRef`'s six kinds (`RESOURCE_REF_PROVIDERS`,
 * ./resource-ref.ts). `jira-idea` and `zendesk-ticket` are resource types
 * this codebase already staffs agents for (src/resources/jira-idea.ts,
 * zendesk-ticket.ts) but are deliberately excluded from `ResourceRef` itself
 * — see that module's own header. Capability declaration needs to answer
 * for all eight, so this list is its own, wider superset rather than an
 * extension of `RESOURCE_REF_PROVIDERS`.
 */
export const CAPABILITY_PROVIDERS = [
  "jira-work-item",
  "jira-project",
  "jira-idea",
  "confluence-page",
  "github-issue",
  "zendesk-ticket",
  "filesystem",
  "webpage",
] as const;
export type CapabilityProvider = (typeof CAPABILITY_PROVIDERS)[number];

/** The six capability categories this ticket's inventory covers. */
export const CAPABILITIES = ["query", "read", "snapshot", "comments", "links", "createTask"] as const;
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
  | ({ provider: "zendesk-ticket" } & ZendeskTicketRef);

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
const MATRIX: Record<CapabilityProvider, Record<Capability, boolean>> = {
  "jira-work-item": { query: true, read: true, snapshot: true, comments: true, links: true, createTask: false },
  "jira-project": { query: true, read: false, snapshot: false, comments: false, links: true, createTask: false },
  "jira-idea": { query: true, read: true, snapshot: false, comments: false, links: false, createTask: false },
  "confluence-page": { query: false, read: false, snapshot: false, comments: false, links: true, createTask: false },
  "github-issue": { query: true, read: true, snapshot: false, comments: false, links: true, createTask: false },
  "zendesk-ticket": { query: true, read: true, snapshot: false, comments: false, links: false, createTask: false },
  filesystem: { query: false, read: false, snapshot: false, comments: false, links: true, createTask: false },
  webpage: { query: false, read: false, snapshot: false, comments: false, links: true, createTask: false },
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
