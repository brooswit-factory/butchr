# Provider capabilities: declaration mechanism, the comments capability, and the 8×6 inventory

FACTORY-23 (implementing story FACTORY-20, epic FACTORY-10). Design source: an
external contractor's Confluence handoff — validated against real code below,
not treated as a mandate; every departure from it is called out explicitly.
Downstream consumer: FACTORY-13 (project-level events), whose own prerequisite
this story is; FACTORY-21 (extending comments + capability declaration to the
other seven providers) is filed and deliberately shelved until this PR is
open.

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
  `jira-work-item` only.

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
export async function readComments(client, ref: CapabilityRef): Promise<Comment[]>;
export async function addComment(client, ref: CapabilityRef, body: string): Promise<CommentRef>;
```

Implemented for **`jira-work-item` only**, reusing `AtlassianClient`'s
existing native comment methods — `allComments`/`addComment`
(`src/atlassian/client.ts`) — exactly the way `createJiraIdeaClient`
(`src/resources/jira-idea.ts`) already reuses them for `jira-idea`. No
duplicate Jira comment logic was written.

**Ordering and pagination, stated as required:** oldest-first
(`AtlassianClient.allComments`'s own `orderBy=created`), paged 100 comments at
a time, capped at 1000 comments by default — all pre-existing behaviour,
reused unchanged. A ticket with more comments than the cap makes
`allComments` throw rather than silently truncating, so `readComments` never
returns a partial list: it either returns every comment or rejects. No new
paging logic was added by this story.

Calling `readComments`/`addComment` with any `CapabilityRef` other than
`jira-work-item` throws `UnsupportedCapabilityError` (via `assertSupports`)
before any provider-specific code runs — one shared entry point, uniform
failure, no cross-provider branch a caller has to write itself.

**Named, deliberate scope limits — real, working code that is NOT wired into
this interface, on purpose:**

- **`zendesk-ticket` already has a complete, working comment implementation**
  — `ZendeskTicketClient.comments`/`addInternalNote`
  (`src/resources/zendesk-ticket.ts`): cursor-paginated, oldest-first, capped,
  and a private-note-only write that verifies Zendesk's own audit didn't mark
  it public. It predates this ticket and is unrelated to it. Declaring
  `zendesk-ticket`'s `comments` capability `true` here would have been *more*
  truthful about what this codebase can do, but the ticket's own scope is
  explicit: "Other providers must declare comments as unsupported ... —
  implementing them is a follow-on story and is OUT of scope." Wiring this
  existing client into `readComments`/`addComment` is a small, well-understood
  follow-on for FACTORY-21, not a gap this story left by oversight.
- **`jira-idea` already has a working comment wrapper** too
  (`createJiraIdeaClient.comments`/`.addComment`,
  `src/resources/jira-idea.ts`) — same story: real, out of scope, a trivial
  FACTORY-21 follow-on (it would need the same `get()`-then-act reverification
  `createJiraIdeaClient.addComment` already does, to avoid writing a comment
  to an issue that stopped being a proven idea between the capability check
  and the write).
- **`jira-project` has no native "project comment" concept in Jira at all** —
  comments belong to issues, never to a project as such. **For FACTORY-13,
  which explicitly asked what a jira-project resource should declare:**
  `jira-project` declares `comments: false` here, not because a follow-on
  story merely hasn't gotten to it yet (as with jira-idea/zendesk-ticket
  above), but because there is no obvious native referent for "a jira-project
  comment" to reuse — it would have to be *defined* first (e.g. an aggregate
  of its issues' comments, a synthetic per-project discussion, or something
  else), which is a design question outside this ticket's mechanical scope,
  not an implementation gap. FACTORY-13/FACTORY-21 should settle what (if
  anything) this should mean before any code declares it `true`.

## The 8×6 inventory

Status is the ACTUAL state of the code today, not the handoff's own "to
inventory" table (not copied — this was built by reading the code). `✓
declared` means `capabilities.ts` declares it `true`; a `false` cell may
still be "partial" in the code — see the note.

| provider | query/enumerate | resolve/read | snapshot/watch/diff | comments | links | createTask |
|---|---|---|---|---|---|---|
| **jira-work-item** | ✓ supported — `AtlassianClient.search`/`searchAll` (`src/atlassian/client.ts`), driving `createTodoWorkersFetch` (`src/resources/issue.ts`) | ✓ supported — `AtlassianClient.issue()` | ✓ supported — `createIssueEventRules` (`src/resources/issue.ts`), the daemon's core poll/diff loop | ✓ **supported (this story)** — `readComments`/`addComment` (`src/resources/comments.ts`) over `AtlassianClient.allComments`/`addComment` | ✓ supported — native `AtlassianClient.links()` + managed (`src/resources/link-store.ts`, routed via `link-store-router.ts`) | ✗ absent |
| **jira-project** | ✓ supported — `AtlassianClient.searchProjects` + `parseProjectQuery` (`src/resources/jira-project.ts`) | ✗ **partial, declared false** — no dedicated `getProject(key)`; project search is the only read path | ✗ absent — no event-rules/poll wiring for projects | ✗ **unsupported — see above, a design question, not merely unimplemented** | ✓ supported — `jira-project-link-store.ts`'s project-property-backed `LinkStore` (FACTORY-5/8), routed by `link-store-router.ts` | ✗ absent |
| **jira-idea** | ✓ supported — same `AtlassianClient.search`/`searchAll`, filtered by `jiraIssueClass` (`src/resources/jira-idea.ts`) | ✓ supported — `createJiraIdeaClient.get()`, fail-closed type check | ✗ absent — no idea-specific event rules | ✗ **unsupported here — but `createJiraIdeaClient.comments`/`.addComment` already work; out of scope, FACTORY-21** | ✗ **partial, declared false** — GitHub-issue remote links only (`linkedGithubIssues`/`linkGithubIssue`); no managed-link-store integration, and excluded from `ResourceRef` | ✗ absent |
| **confluence-page** | ✗ absent — `confluence-page-ref.ts` is pure identity/parsing, no live query | ✗ **partial, declared false** — `AtlassianClient.confluencePageVersion(pageId)` reads only `version.number`, never content; `get_doc`/`confluence_get_page` (a different subsystem, butchr's own MCP-doc tools) reads content but is not this interface | ✗ **partial, declared false** — `confluencePageVersion` is exactly the change-token hook `src/jira-watch/external-poll.ts` already uses | ✗ unsupported | ✓ supported — one of `ResourceRef`'s six kinds, generic file-backed `LinkStore` | ✗ absent |
| **github-issue** | ✓ supported — `createGithubIssueClient.searchAll` (`src/resources/github-issue.ts`) | ✓ supported — `.get()` | ✗ absent — no snapshot/diff/event-rules | ✗ **unsupported here — real `GithubComment`-shaped read/write exist in `github-issue.ts`'s own client (used by `github_add_comment`, a provider-specific MCP tool); not wired into this shared interface, out of scope** | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |
| **zendesk-ticket** | ✓ supported — `ZendeskTicketClient.searchAll` (`src/resources/zendesk-ticket.ts`) | ✓ supported — `.get()` | ✗ absent | ✗ **unsupported here — see above, a real working implementation exists, out of scope FACTORY-21** | ✗ **absent from the capability mechanism** — excluded from `ResourceRef`/`link-store`, so no managed-link path at all | ✗ absent |
| **filesystem** | ✗ absent — `filesystem-ref.ts` is pure path-identity/normalization, no read/stat/watch code | ✗ absent | ✗ absent | ✗ unsupported | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |
| **webpage** | ✗ absent — `webpage-ref.ts` is pure URL-identity/canonicalization, no fetch code | ✗ absent | ✗ absent (`linked-discovery.ts` has a `webpage` `LinkedItemKind` — discovery classification, not a reader) | ✗ unsupported | ✓ supported — one of `ResourceRef`'s six kinds | ✗ absent |

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
   phrasing ("does this resource support X") reads as binary, but several
   providers have real, working, non-generic code for a capability
   (`jira-idea`/`zendesk-ticket` comments; `github-issue`'s own comment tool)
   that this story does not wire into the shared interface, by explicit scope
   instruction. Declaring those `true` would be false in exactly the sense
   the ticket warns against ("never ... a faked result"); declaring them
   `false` risks reading as "this codebase can't do X" when it demonstrably
   can, just not *through this interface yet*. This doc's deviation notes
   above exist specifically to close that gap in the record.
3. **Some `false` cells are genuine gaps (jira-project comments has no defined
   meaning yet, needs product/design input from FACTORY-13/21) while others
   are pure scheduling (`jira-idea`/`zendesk-ticket` comments — the code
   already exists, wiring is mechanical).** Treating all "false, not yet
   wired" cells identically would hide that difference from whoever plans
   FACTORY-21; this doc calls it out per-cell instead.
4. **"Partial" is a real, load-bearing third state the runtime API deliberately
   does not expose.** `jira-project`'s read and `confluence-page`'s read are
   both "there is code, but it does not answer the generic question a caller
   without provider knowledge would ask" — collapsing that to the boolean
   `supports()` needs (see "A capability is declared `true` only when...")
   loses information a human reviewing this doc needs, which is why the
   inventory table states it explicitly even though `capabilities.ts` cannot.

## Verification

- `bun run typecheck` — clean.
- `bun test test/unit test/load` — full existing suite plus this story's new
  tests (`test/unit/capabilities.test.ts`, `test/unit/comments.test.ts`), 0
  failures.
- `bun run scripts/coverage/gate.ts` — project-wide coverage stayed above the
  90% line/function minimum (both new files at 100%/100%).
- See this ticket's PR description for whether the Confluence task doc could
  also be written, and why if not.
