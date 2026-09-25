# Provider capabilities: declaration mechanism, the comments capability, and the 8×6 inventory

FACTORY-23 (implementing story FACTORY-20, epic FACTORY-10) shipped the
mechanism and wired `comments` for `jira-work-item` only. FACTORY-25
(implementing story FACTORY-21) completes the inventory this doc promised:
`comments` is now wired for `jira-idea`, `github-issue` and `zendesk-ticket`
too, every remaining `false` cell has been re-verified against the code
rather than carried forward, and the client-argument shape `readComments`/
`addComment` take has changed (see "The comments capability" below). Design
source throughout: an external contractor's Confluence handoff — validated
against real code, not treated as a mandate; every departure from it is
called out explicitly. Downstream consumer: FACTORY-13 (project-level
events), whose own prerequisite this story is.

## Why this exists

Calling code (today: nothing yet — this ships the mechanism and its first,
and so far only, real caller) needs to ask "does this resource support
capability X?" and get a straight answer, without knowing anything
provider-specific — and, if it goes ahead and invokes an unsupported
capability anyway, needs a typed, programmatically detectable failure rather
than a silent no-op, a thrown generic `Error` indistinguishable from a bug, or
a faked result.

This is **additive only**. Nothing in `src/resources/resource-ref.ts`,
`link-store.ts`, `issue.ts`, `jira-idea.ts`, `zendesk-ticket.ts`, or any
provider's existing query/read/links code was rewritten. The two new modules:

- `src/resources/capabilities.ts` — the declaration mechanism.
- `src/resources/comments.ts` — the comments capability, implemented for
  `jira-work-item`, `jira-idea`, `github-issue` and `zendesk-ticket` (the
  first three were added by FACTORY-25; see "The comments capability" below).

## The declaration mechanism (`src/resources/capabilities.ts`)

```ts
export const CAPABILITY_PROVIDERS = [
  "jira-work-item", "jira-project", "jira-idea", "confluence-page",
  "github-issue", "zendesk-ticket", "filesystem", "webpage",
] as const;
export type CapabilityProvider = (typeof CAPABILITY_PROVIDERS)[number];

export const CAPABILITIES = ["query", "read", "snapshot", "comments", "links", "createTask"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityRef =
  | ResourceRef                                          // the six resource-ref.ts kinds
  | ({ provider: "jira-idea" } & JiraWorkItemRef)        // bare {key}, same shape as jira-work-item
  | ({ provider: "zendesk-ticket" } & ZendeskTicketRef); // {subdomain, id}

export function capabilitiesOf(ref: CapabilityRef): Capability[];
export function supports(ref: CapabilityRef, capability: Capability): boolean;
export function assertSupports(ref: CapabilityRef, capability: Capability): void; // throws UnsupportedCapabilityError
export class UnsupportedCapabilityError extends Error { readonly provider; readonly capability; }
```

**Deviation from the handoff's "given a canonical resource reference" framing,
forced by reality:** the handoff assumed one ref type could name all eight
providers. `ResourceRef` (`src/resources/resource-ref.ts`) — the pre-existing,
already-shipped type from FACTORY-4/7 — deliberately covers only **six**
providers; `jira-idea` and `zendesk-ticket` were excluded from it on purpose
in that story (see that module's own header). This ticket's inventory needs
all eight, and rewriting `ResourceRef` to add two more members was explicitly
out of scope ("do NOT rewrite existing query/links code"). `CapabilityRef`
is therefore its own, wider union: every `ResourceRef` is already a valid
`CapabilityRef` (no wrapping needed at a call site that already has one), and
the two extra providers get their own minimal variant. A `jira-idea` ref has
no dedicated `-ref.ts` module to import — `jiraIssueClass()`
(`src/resources/jira-idea.ts`) proves an issue is an idea only at runtime
(issue type `Idea` **and** project type `product_discovery`); it is not
distinguishable from a `jira-work-item` ref by shape alone, ever. That's
already true of the rest of this codebase (`CallerIdentity`,
`src/mcp/identity.ts`, has entirely separate `jira-idea`/`jira-work` members
resolved from which MCP headers a request carries, never from payload shape)
— `CapabilityRef` doesn't invent a new problem, it inherits an existing one.

**A capability is declared `true` only when a caller with zero
provider-specific knowledge can use it through one shared entry point today.**
A "partial" implementation that only a provider-aware caller could use
correctly — confluence-page's version-number-only read, jira-project's
search-only lookup — is declared `false`. This is a deliberate reading of
"truthfully declarable": declaring `read: true` for confluence-page because
*a* read path exists somewhere would be a promise this interface cannot keep
for a caller that goes on to expect page content back.

## The comments capability (`src/resources/comments.ts`)

```ts
export interface Comment { id: string; author: string | null; timestamp: string; body: string }
export interface CommentRef { id: string }
export interface CommentClients {
  "jira-work-item"?: Pick<AtlassianClient, "allComments" | "addComment">;
  "jira-idea"?: Pick<JiraIdeaClient, "comments" | "addComment">;
  "github-issue"?: Pick<GithubIssueClient, "comments" | "addComment">;
  "zendesk-ticket"?: Pick<ZendeskTicketClient, "comments" | "addInternalNote">;
}
export async function readComments(clients: CommentClients, ref: CapabilityRef): Promise<Comment[]>;
export async function addComment(clients: CommentClients, ref: CapabilityRef, body: string): Promise<CommentRef>;
```

Implemented for **`jira-work-item`, `jira-idea`, `github-issue` and
`zendesk-ticket`** (FACTORY-25/FACTORY-21 wired the latter three; FACTORY-23
shipped `jira-work-item`). Every provider reuses its own existing native
comment client — no duplicate comment logic anywhere:

- `jira-work-item`: `AtlassianClient.allComments`/`addComment`
  (`src/atlassian/client.ts`).
- `jira-idea`: `JiraIdeaClient.comments`/`.addComment`
  (`src/resources/jira-idea.ts`) — `comments` delegates straight to
  `AtlassianClient.allComments` (the exact same function `jira-work-item`
  uses, so ordering/pagination/cap are identical by construction), and
  `addComment` keeps its pre-existing `get()`-then-act re-verification: a
  comment can never be written to an issue that stopped being a proven idea
  between the capability check and the write.
- `github-issue`: `GithubIssueClient.comments`/`.addComment`
  (`src/resources/github-issue.ts`) — `addComment` re-reads the issue
  (`get()`) before every write, refusing a pull request or an issue outside
  `BUTCHR_GITHUB_ORGS`.
- `zendesk-ticket`: `ZendeskTicketClient.comments`/`addInternalNote`
  (`src/resources/zendesk-ticket.ts`) — the write is **private-note-only**;
  `addInternalNote` itself verifies Zendesk's own audit didn't mark the note
  public, and `comments.ts` adds no public-reply path on top of it. Its `id`
  can come back `null` (the audit didn't carry one) — `comments.ts` treats
  that as a rejection, never a faked `CommentRef`.

**Ordering and pagination, stated as required — every wired provider is
oldest-first and returns everything or rejects, never silently truncates, all
pre-existing behaviour reused unchanged:**

| provider | order | page size | cap | source |
|---|---|---|---|---|
| jira-work-item / jira-idea | oldest-first (Jira `orderBy=created`) | 100 | 1000 | `AtlassianClient.allComments` |
| github-issue | oldest-first (the endpoint's undocumented but observed default; no `sort` param exists for it) | 100 | 3000 | `GithubIssueClient.comments` |
| zendesk-ticket | oldest-first (`sort_order: asc`) | 100, cursor-paginated | 3000 | `ZendeskTicketClient.comments` |

No new paging logic was added by this story or its predecessor.

Calling `readComments`/`addComment` with a `CapabilityRef` whose provider
hasn't declared `comments` throws `UnsupportedCapabilityError` (via
`assertSupports`) before any provider-specific code runs — one shared entry
point, uniform failure, no cross-provider branch a caller has to write
itself.

**Client-argument design decision (FACTORY-25).** The original signature took
a single Jira-typed `client` — workable only while `jira-work-item` was the
only wired provider. `CommentClients` replaces it with a per-provider BAG:
one optional field per provider `comments.ts` knows how to talk to, keyed by
the same `CapabilityProvider` string `ref.provider` already carries.
`readComments`/`addComment` switch on `ref.provider`, pull the matching field
out of the bag, and throw a plain `Error` (never `UnsupportedCapabilityError`
— the capability genuinely is supported; the caller simply didn't supply a
client for it) if that field is missing. This was chosen over a discriminated
single-client argument (`{provider: "jira-work-item", client} | {provider:
"jira-idea", client} | ...`) because a bag lets one call site hold clients for
several providers at once without a runtime tag, and because it makes "which
providers has this caller wired up" readable at a glance from the object's
keys. The `jira-work-item` field's type is exactly the old bare-client type,
so every `jira-work-item` caller keeps working — it now passes
`{ "jira-work-item": client }` instead of `client`. (There were, and remain,
no non-test call sites for `readComments`/`addComment` in this codebase today
— FACTORY-20/23/25 ship the mechanism and its tests, not a caller — so "keep
the call sites working" in practice meant `test/unit/comments.test.ts`.)

**Named, deliberate scope limits — real, working code that is NOT wired into
this interface, on purpose:**

- **`jira-project` has no native "project comment" concept in Jira at all** —
  comments belong to issues, never to a project as such. **For FACTORY-13,
  which explicitly asked what a jira-project resource should declare:**
  `jira-project` declares `comments: false` here, not because implementing it
  merely hasn't happened yet (as with the three providers wired this story),
  but because there is no obvious native referent for "a jira-project
  comment" to reuse — it would have to be *defined* first (e.g. an aggregate
  of its issues' comments, a synthetic per-project discussion, or something
  else), which is a design question outside this ticket's mechanical scope,
  not an implementation gap. FACTORY-13 should settle what (if anything) this
  should mean before any code declares it `true`.
- **`confluence-page` has real, reusable comment code too — found during this
  story's own "verify nothing is being skipped by mistake" check, and
  deliberately NOT wired in.** `AtlassianOps.commentOnPage`/`getPageComments`
  (`src/tools/atlassian.ts`, implemented in `src/tools/atlassian-real.ts`) is
  a complete, working Confluence FOOTER-comment read/write: `commentOnPage`
  posts storage-format XHTML via `POST /wiki/api/v2/footer-comments`,
  `getPageComments` paginates `GET /wiki/api/v2/pages/{id}/footer-comments`
  to exhaustion and throws rather than returning a partial list on a
  malformed/never-terminating cursor. It is real and it is reusable in
  principle — but it lives on `AtlassianOps`, the daemon's own internal tool
  surface (built for `report_to_boss`/`ask_boss`/`get_doc_comments` from a
  PROJECT caller and for the project root-doc "comment received" wake event,
  BUTCHR-62/67/71/107/109/227/309), not on a `confluence-page`-shaped client
  any `CapabilityRef` caller could hold, and its comment shape (`{id, body,
  author?, created?}`, storage-format XHTML body) has never been mapped onto
  this module's canonical `Comment`. Wiring it into `readComments`/
  `addComment` — deciding what a generic `confluence-page` caller's `body`
  should look like (storage-format XHTML vs. plain text), whether inline
  comments belong too, and how an `AtlassianOps`-shaped dependency reaches a
  `CommentClients` bag — is exactly the kind of design question this
  mechanical inventory story is not scoped to answer. `confluence-page`
  therefore stays `comments: false`, same as before, but for a materially
  different reason than "nobody's looked yet": this doc now records that
  someone has looked, found real code, and is flagging it (per this story's
  own instruction) rather than expanding scope silently or letting the doc
  imply no such code exists.
- **`filesystem`/`webpage` have no comment concept of any kind** — no code to
  find, nothing to flag; unsupported for the plain reason that nothing exists.

## The 8×6 inventory

Status is the ACTUAL state of the code today, not the handoff's own "to
inventory" table (not copied — this was built by reading the code). `✓
declared` means `capabilities.ts` declares it `true`; a `false` cell may
still be "partial" in the code — see the note.

| provider | query/enumerate | resolve/read | snapshot/watch/diff | comments | links | createTask |
|---|---|---|---|---|---|---|
| **jira-work-item** | ✓ supported — `AtlassianClient.search`/`searchAll` (`src/atlassian/client.ts`), driving `createTodoWorkersFetch` (`src/resources/issue.ts`) | ✓ supported — `AtlassianClient.issue()` | ✓ supported — `createIssueEventRules` (`src/resources/issue.ts`), the daemon's core poll/diff loop | ✓ supported (FACTORY-23) — `readComments`/`addComment` (`src/resources/comments.ts`) over `AtlassianClient.allComments`/`addComment` | ✓ supported — native `AtlassianClient.links()` + managed (`src/resources/link-store.ts`, routed via `link-store-router.ts`) | ✗ absent |
| **jira-project** | ✓ supported — `AtlassianClient.searchProjects` + `parseProjectQuery` (`src/resources/jira-project.ts`) | ✗ **partial, declared false** — no dedicated `getProject(key)`; project search is the only read path | ✗ absent — no event-rules/poll wiring for projects | ✗ **unsupported — see above, a design question (no native "project comment" concept), not merely unimplemented; re-verified FACTORY-25, unchanged** | ✓ supported — `jira-project-link-store.ts`'s project-property-backed `LinkStore` (FACTORY-5/8), routed by `link-store-router.ts` | ✗ absent |
| **jira-idea** | ✓ supported — same `AtlassianClient.search`/`searchAll`, filtered by `jiraIssueClass` (`src/resources/jira-idea.ts`) | ✓ supported — `createJiraIdeaClient.get()`, fail-closed type check | ✗ absent — no idea-specific event rules | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `JiraIdeaClient.comments`/`.addComment`, `get()`-then-act re-verification preserved on every write | ✗ **partial, declared false, re-verified FACTORY-25 — unchanged** — GitHub-issue remote links only (`linkedGithubIssues`/`linkGithubIssue`); no managed-link-store integration, and still excluded from `ResourceRef` (`link-store-router.ts` only routes owner keys `formatResourceRef` can produce, which `jira-idea` isn't one of) | ✗ absent |
| **confluence-page** | ✗ absent — `confluence-page-ref.ts` is pure identity/parsing, no live query | ✗ **partial, declared false** — `AtlassianClient.confluencePageVersion(pageId)` reads only `version.number`, never content; `get_doc`/`confluence_get_page` (a different subsystem, butchr's own MCP-doc tools) reads content but is not this interface | ✗ **partial, declared false** — `confluencePageVersion` is exactly the change-token hook `src/jira-watch/external-poll.ts` already uses | ✗ **unsupported, but NOT for lack of code — see "The comments capability" above.** `AtlassianOps.commentOnPage`/`getPageComments` (`src/tools/atlassian.ts`/`atlassian-real.ts`) is a real, working, paginated-to-exhaustion Confluence footer-comment read/write. Found during FACTORY-25's own "verify nothing is being skipped" check and deliberately not wired in — it lives on the daemon's internal `AtlassianOps` surface (built for project root-doc speak/listen, BUTCHR-62/67/71/etc.), not on a `confluence-page`-shaped client, and mapping its storage-format-XHTML comment shape onto this module's canonical `Comment` is a design question, not a mechanical wiring job | ✓ supported — one of `ResourceRef`'s six kinds, generic file-backed `LinkStore` | ✗ absent |
| **github-issue** | ✓ supported — `createGithubIssueClient.searchAll` (`src/resources/github-issue.ts`) | ✓ supported — `.get()` | ✗ absent — no snapshot/diff/event-rules | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `GithubIssueClient.comments`/`.addComment` (the same client `github_add_comment`, a provider-specific MCP tool, already used) — `.addComment` re-reads the issue first, refusing a pull request or an issue outside `BUTCHR_GITHUB_ORGS` | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |
| **zendesk-ticket** | ✓ supported — `ZendeskTicketClient.searchAll` (`src/resources/zendesk-ticket.ts`) | ✓ supported — `.get()` | ✗ absent | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `ZendeskTicketClient.comments`/`addInternalNote`; the write stays private-note-only (no public-reply path added), and a `null` note id from `addInternalNote`'s audit is treated as a rejection, never a faked `CommentRef` | ✗ **absent from the capability mechanism, re-verified FACTORY-25 — unchanged** — excluded from `ResourceRef`/`link-store`, so no managed-link path at all | ✗ absent |
| **filesystem** | ✗ absent — `filesystem-ref.ts` is pure path-identity/normalization, no read/stat/watch code | ✗ absent | ✗ absent | ✗ unsupported — no comment concept of any kind, nothing to reuse | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |
| **webpage** | ✗ absent — `webpage-ref.ts` is pure URL-identity/canonicalization, no fetch code | ✗ absent | ✗ absent (`linked-discovery.ts` has a `webpage` `LinkedItemKind` — discovery classification, not a reader) | ✗ unsupported — no comment concept of any kind, nothing to reuse | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |

**`createTask`: absent for every provider, cheaply and honestly.** Zero
occurrences of `createTask`/`create_task` anywhere in `src/` — nothing to
point at, nothing built, no follow-on required by this ticket to "cheaply
state" this; it is simply true.

**"Multi-query resource-agent definitions": absent by construction.** The
rule schema (`RuleSchema`, `src/rules/rules.ts`) has exactly one `query:
string` field per rule — singular, no array/multi-query shape exists anywhere
in `src/rules/`. Every resource-agent definition this codebase can express is
single-query.

## Where reality forced a deviation from the handoff, and where the handoff's model doesn't survive contact with Factory

1. **A single ref type cannot name all eight providers without either
   rewriting `ResourceRef` (out of scope) or accepting a wider, capability-only
   union that overlaps but doesn't equal it.** `CapabilityRef` is that union —
   see "The declaration mechanism" above. This is the single largest departure
   from the handoff's implicit assumption of one universal resource
   identifier.
2. **"Capability" and "has any code for it" are not the same question, and
   conflating them would make the declaration untruthful.** The handoff's own
   phrasing ("does this resource support X") reads as binary, but
   `confluence-page` has real, working, non-generic comment code
   (`AtlassianOps.commentOnPage`/`getPageComments`) that this story does not
   wire into the shared interface — FACTORY-23 found the analogous situation
   for `jira-idea`/`zendesk-ticket`/`github-issue` comments, and FACTORY-25
   closed those three by wiring them in; `confluence-page`'s case is
   materially different (see "The comments capability" above: it needs a
   design decision about body format and dependency shape, not just
   mechanical wiring) and stays open. Declaring `confluence-page`'s comments
   `true` here would be false in exactly the sense the ticket warns against
   ("never ... a faked result"); declaring it `false` with no further note
   would risk reading as "this codebase can't do X" when it demonstrably can,
   just not *through this interface yet*. This doc's deviation notes above
   exist specifically to close that gap in the record.
3. **Some `false` cells are genuine gaps (jira-project comments has no defined
   meaning yet, needs product/design input from FACTORY-13) while others were
   pure scheduling that FACTORY-25 has now closed (`jira-idea`/
   `github-issue`/`zendesk-ticket` comments — the code already existed,
   wiring was mechanical) — and `confluence-page` comments turned out to be a
   third kind: real code exists, but wiring it is itself a design question,
   not purely mechanical.** Treating all "false" cells identically would hide
   these differences from whoever plans the next story; this doc calls each
   one out per-cell instead.
4. **"Partial" is a real, load-bearing third state the runtime API deliberately
   does not expose.** `jira-project`'s read and `confluence-page`'s read are
   both "there is code, but it does not answer the generic question a caller
   without provider knowledge would ask" — collapsing that to the boolean
   `supports()` needs (see "A capability is declared `true` only when...")
   loses information a human reviewing this doc needs, which is why the
   inventory table states it explicitly even though `capabilities.ts` cannot.

## Verification

- `bun run typecheck` — clean.
- `bun test test/unit test/load` — full existing suite plus this story's
  updated/new tests (`test/unit/capabilities.test.ts`,
  `test/unit/comments.test.ts`), 0 failures.
- `bun run scripts/coverage/gate.ts` — project-wide coverage stayed above the
  90% line/function minimum (the gate is whole-project, not per-file; see its
  own source, `scripts/coverage/gate.ts` — the "100%/100%" this doc claimed
  for FACTORY-23's two new files was a fact about that run, never an enforced
  per-file requirement).
- `bun run check` (preflight, generate, typecheck, the full test suite, the
  coverage gate, `verify-generated-is-committed`, build) — green end to end.
- `test/unit/capabilities.test.ts` now includes a test that pins the entire
  8×6 `MATRIX` against an inline expected table, so a future accidental
  change to any cell fails loudly and specifically rather than only shifting
  an unrelated per-provider assertion.
