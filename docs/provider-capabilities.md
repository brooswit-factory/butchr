# Provider capabilities: declaration mechanism, the comments capability, and the 9×6 inventory (8×6 before FACTORY-57 added github-pr)

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

FACTORY-31 (implementing story FACTORY-29) wires `comments` for
`confluence-page` too — the fifth and, per this doc's own "named, deliberate
scope limits" section below (as it stood before this story), the last
provider with real-but-unwired comment code. `readComments`/`addComment` now
support `jira-work-item`, `jira-idea`, `github-issue`, `zendesk-ticket` AND
`confluence-page`; `confluence-page`'s `comments` MATRIX cell flips to `true`.
See "The comments capability" below for the two design decisions this
required (body-format asymmetry, dependency shape) and the "Definition of
done" findings folded into it (client-side sort, `commentOnPage`'s unreliable
id, footer-vs-inline scope).

FACTORY-26 (implementing story FACTORY-21) re-truths the `filesystem` row
after `main` landed BUTCHR-407 ("Add filesystem resource provider" —
`src/resources/filesystem.ts`'s `listFilesystemResources`) and BUTCHR-408 (the
managed-sessions built-in rule, `src/rules/session-definition-type.ts`),
which this branch's own base-merge of `main` brought in: `query` moves to
`true` (a real generic query entry point now exists — it didn't before);
`read` and `snapshot` were re-verified and stay `false`, for reasons spelled
out per-cell in the table below rather than carried forward unchecked. Also
confirmed: **BUTCHR-408's `session-definition` is a rule TYPE built over
`filesystem` resources (`builtinManagedSessionsRule` constructs an ordinary
`resourceProvider: "filesystem"` `Rule`, `session-definition-type.ts`), not a
ninth capability provider** — `CAPABILITY_PROVIDERS` correctly stays at
eight; nothing about this doc's provider list changes.

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
  `jira-work-item`, `jira-idea`, `github-issue`, `zendesk-ticket` and
  `confluence-page` (the first three were added by FACTORY-25;
  `confluence-page` by FACTORY-31; see "The comments capability" below).

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
  "confluence-page"?: Pick<AtlassianOps, "commentOnPage" | "getPageComments">;
}
export async function readComments(clients: CommentClients, ref: CapabilityRef): Promise<Comment[]>;
export async function addComment(clients: CommentClients, ref: CapabilityRef, body: string): Promise<CommentRef>;
```

Implemented for **`jira-work-item`, `jira-idea`, `github-issue`,
`zendesk-ticket` and `confluence-page`** (FACTORY-25/FACTORY-21 wired the
middle three; FACTORY-23 shipped `jira-work-item`; FACTORY-31/FACTORY-29
wired `confluence-page`, the last of the five). Every provider reuses its own
existing native comment client — no duplicate comment logic anywhere:

**`github-pr` (FACTORY-57) is deliberately NOT added to `CommentClients`
above.** It has its own comment read/write (`github_get_pr`/
`github_pr_add_comment`, `src/tools/github-pr.ts`, calling
`GithubPrClient.comments`/`.addComment` — same re-verification discipline as
`github-issue`'s own `addComment`), so the CAPABILITY is genuinely wired (see
the 9×6 table below) — it just doesn't ride this specific shared module.
Folding it in would mean widening `CapabilityRef`'s `CommentClients` shape
for one provider whose tools already work correctly on their own, for no
behavior change; left as a documented, deliberate gap rather than done for
its own sake.

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
  that as a rejection, never a faked `CommentRef`. **This rejection is
  write-succeeded-but-unconfirmed, not write-failed:** by the time `id` comes
  back `null`, `addInternalNote` has already posted the note — only its id
  failed to come back — so the thrown error says explicitly that the note WAS
  posted and that a caller must NOT retry (a retry would duplicate the note).
  A caller that wants the id back must go read the ticket's comments instead
  of resubmitting the write.
- `confluence-page` (FACTORY-31): `AtlassianOps.getPageComments`/
  `commentOnPage` (`src/tools/atlassian.ts`, implemented in
  `src/tools/atlassian-real.ts`) — Confluence FOOTER comments only; inline
  comments are a separate Confluence concept/endpoint and are neither read
  nor written through this interface. See "Design decisions" below for body
  format, dependency shape, ordering, and `commentOnPage`'s id-reliability
  finding.

**Ordering and pagination, stated as required — every wired provider is
oldest-first and returns everything or rejects, never silently truncates, all
pre-existing behaviour reused unchanged:**

| provider | order | page size | cap | source |
|---|---|---|---|---|
| jira-work-item / jira-idea | oldest-first (Jira `orderBy=created`) | 100 | 1000 | `AtlassianClient.allComments` |
| github-issue | oldest-first (the endpoint's undocumented but observed default; no `sort` param exists for it) | 100 | 3000 | `GithubIssueClient.comments` |
| zendesk-ticket | oldest-first (`sort_order: asc`) | 100, cursor-paginated | 3000 | `ZendeskTicketClient.comments` |
| confluence-page | oldest-first, but **sorted client-side in `comments.ts`** — the server requests no `sort` at all | 250, cursor-paginated | none (paginates to exhaustion; throws rather than truncating on a malformed/never-terminating cursor) | `AtlassianOps.getPageComments` + `comments.ts`'s own `.sort()` |

No new paging logic was added by this story or its predecessor; `comments.ts`
adds sorting only, for `confluence-page`, on top of `getPageComments`'
existing pagination.

## Design decisions for `confluence-page` (FACTORY-29/31)

**1. Body format is asymmetric by direction — `addComment` takes plain text,
`readComments` returns storage-format XHTML as-is.** Every other provider's
`addComment(body: string)` already takes plain text; the shared interface's
whole point is that a caller needs zero provider knowledge. Requiring
pre-formatted XHTML from every `addComment` caller would make a caller who
passes `"a < b"` or `"x & y"` silently post a malformed or misrendered
comment (or draw a 400) the moment it forgot Confluence's escaping rules. So
`addComment` wraps the plain text into storage format itself
(`plainTextToStorageXHTML`, `src/resources/comments.ts`): HTML-escape
`& < > " '`, then turn each blank-line-separated paragraph into `<p>…</p>`
with single newlines inside a paragraph becoming `<br/>`. **Alternative
rejected:** taking pre-formatted XHTML through `addComment` directly — this
would put a Confluence-specific representation onto the one interface whose
entire purpose is hiding representation differences, and is not supported;
a caller that genuinely holds raw storage-format XHTML must call
`AtlassianOps.commentOnPage` directly instead (the provider-specific path
stays available, unchanged, alongside this one).

Read direction is the mirror image, deliberately NOT symmetric:
`Comment.body` for `confluence-page` is exactly what `getPageComments`
returns — storage-format XHTML, untouched. **Alternative rejected:**
stripping/converting it to plain text on the way out, to match what
`addComment` takes in — rejected as lossy (storage XHTML can carry links,
formatting, mentions that plain text cannot represent) and as a second body
dialect this module would then have to maintain forever. The asymmetry is
stated here in words specifically so a caller notices it rather than
assuming write/read round-trip: **what you write in is plain text; what you
read back out is storage-format XHTML, even for a comment this same
interface posted.**

Verified from `src/tools/atlassian-real.ts`'s `getPageComments`: `body` is
`c?.body?.storage?.value ?? ""` — an empty string, never `undefined`, when
the underlying comment carried no body at all. `author` (the commenting
account's Atlassian accountId) and `created` (ISO-8601) are both genuinely
OPTIONAL/`undefined` when Confluence's own response didn't carry them — see
that op's own doc comment on `AtlassianOps` for the live measurements behind
this. `comments.ts`'s mapper carries this through faithfully: `author` maps
to `null` (never fabricated) and `created`'s absence maps `Comment.timestamp`
to `""` (`Comment.timestamp` is a plain, non-optional `string`, and rejecting
a comment outright for lacking a timestamp would make `readComments` less
useful than the raw read it wraps) — done AFTER this module's own sort, which
still sorts on the original optional `created`, never on the post-mapping
`""`.

**2. Dependency shape: `CommentClients` widens with a `"confluence-page"`
field typed as `Pick<AtlassianOps, "commentOnPage" | "getPageComments">`,
via a local type alias next to the existing `JiraCommentClient` etc. — not a
new bespoke `confluence-page` client wrapper class.** Verified, not assumed:
other `src/resources/` modules already take `AtlassianOps` directly as a
dependency (`jira-project-link-store.ts`, `project.ts`) — an
`AtlassianOps`-typed dependency reaching a resources module is existing
precedent in this codebase, not a new layering violation this ticket would
be introducing. A `Pick` of exactly the two methods needed keeps the surface
minimal and lets tests pass a two-method fake, the same discipline every
other `*CommentClient` alias in this module already follows. Missing this
client in the bag throws the same plain `Error` via `requireClient` every
other provider throws — never `UnsupportedCapabilityError` (the capability
genuinely is supported; the caller simply didn't supply a client for it).
`ref -> pageId` goes through `formatConfluencePageRef(ref)`
(`src/resources/confluence-page-ref.ts`) — the existing `confluence-page`
`CapabilityRef`/`ResourceRef` identity, `{ provider: "confluence-page",
pageId }` (`src/resources/capabilities.ts`/`resource-ref.ts`); a non-numeric
`pageId` is rejected by that function's own error, never swallowed here.

**3. `commentOnPage`'s return type is `Promise<unknown>`, and its `id` is not
guaranteed even by the underlying library's OWN schema.** Verified via
confluence.js 3.2.0's own `FooterCommentSchema` (the schema
`createFooterComment` parses every response through, per that client
method's implementation in `node_modules/confluence.js/dist/v2/api/comment.js`):
`id: z.string().optional()` — the schema itself does not promise one, even
though a real 201 response is expected to carry it. `addComment` therefore
follows the exact precedent `zendesk-ticket`'s `addInternalNote` null-id case
already set in this module: it does NOT fake an id when the response carries
none, and it does NOT widen `AtlassianOps.commentOnPage`'s own return type —
`commentOnPage` stays `Promise<unknown>`, unchanged, because the schema-level
optionality is a fact about the underlying library's contract, not something
a narrower TypeScript return type could make more true. When the response
carries a non-empty string `id`, `addComment` validates it and returns
`{ id }`; when it doesn't, `addComment` throws an `Error` stating explicitly
that the comment **WAS posted** (the write already happened; only its id
failed to come back) and that a caller must **NOT retry**, since retrying
would duplicate the comment. Both the id-present and id-missing paths are
tested (`test/unit/comments.test.ts`).

**4. Footer vs. inline comments.** `commentOnPage`/`getPageComments` are
FOOTER comments only — the plain "comment on this page" concept a human sees
at the bottom of a Confluence page. Inline comments (anchored to a text
selection) are a separate Confluence concept and endpoint family that neither
op touches, so a comment made inline through the Confluence UI is invisible
to `readComments`, and `addComment` can never create one. This interface
does not build inline support.

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
- **`confluence-page` is now WIRED (FACTORY-31/FACTORY-29).** FACTORY-25 had
  found `AtlassianOps.commentOnPage`/`getPageComments` (`src/tools/atlassian.ts`,
  implemented in `src/tools/atlassian-real.ts`) — a complete, working
  Confluence FOOTER-comment read/write, paginated to exhaustion, throwing
  rather than truncating on a malformed cursor — but left it unwired,
  because wiring it required two design decisions this mechanical-inventory
  story wasn't scoped to make: what a generic `confluence-page` caller's
  `addComment` `body` should look like, and how an `AtlassianOps`-shaped
  dependency reaches a `CommentClients` bag. FACTORY-29 made both decisions
  and FACTORY-31 implemented them — see "Design decisions for
  `confluence-page`" above for the reasoning and the alternatives rejected.
  `confluence-page` now declares `comments: true`.
- **`filesystem`/`webpage` have no comment concept of any kind** — no code to
  find, nothing to flag; unsupported for the plain reason that nothing exists.

## The 9×6 inventory

Status is the ACTUAL state of the code today, not the handoff's own "to
inventory" table (not copied — this was built by reading the code). `✓
declared` means `capabilities.ts` declares it `true`; a `false` cell may
still be "partial" in the code — see the note. FACTORY-57 (2026-09-26) added
a 9th row, `github-pr` — a mirror of the `github-issue` row directly below
it, same reasoning throughout (its own client's `searchAll`/`.get()`/
`comments`/`.addComment`, no snapshot/diff, one of `ResourceRef`'s now-seven
kinds).

| provider | query/enumerate | resolve/read | snapshot/watch/diff | comments | links | createTask |
|---|---|---|---|---|---|---|
| **jira-work-item** | ✓ supported — `AtlassianClient.search`/`searchAll` (`src/atlassian/client.ts`), driving `createTodoWorkersFetch` (`src/resources/issue.ts`) | ✓ supported — `AtlassianClient.issue()` | ✓ supported — `createIssueEventRules` (`src/resources/issue.ts`), the daemon's core poll/diff loop | ✓ supported (FACTORY-23) — `readComments`/`addComment` (`src/resources/comments.ts`) over `AtlassianClient.allComments`/`addComment` | ✓ supported — native `AtlassianClient.links()` + managed (`src/resources/link-store.ts`, routed via `link-store-router.ts`) | ✗ absent |
| **jira-project** | ✓ supported — `AtlassianClient.searchProjects` + `parseProjectQuery` (`src/resources/jira-project.ts`) | ✗ **partial, declared false** — no dedicated `getProject(key)`; project search is the only read path | ✗ **absent from this capability mechanism, unchanged by BUTCHR-469** — `eventRules.poll` (`createJiraProjectResourceType`, `src/rules/jira-project-type.ts`) is still the trivial always-`deliver:false` stub this cell describes. BUTCHR-469 DID add a real bespoke watch (member discovery + managed-link change/comment events, `discovery.related` → `src/jira-watch/linked-eventing.ts`'s `ProjectLinkedEventingMatch`) — but, same precedent as `filesystem`'s own flagged note below, that is daemon-internal poll/diff plumbing invoked only by this provider's own loop, not a shared `capabilities.ts`-declared, generically-invokable snapshot/diff entry point, so this cell stays `✗` under this table's own bar. See `docs/resource-links.md`'s own BUTCHR-469 section for what actually shipped. | ✗ **unsupported — see above, a design question (no native "project comment" concept), not merely unimplemented; re-verified FACTORY-25, unchanged** | ✓ supported — `jira-project-link-store.ts`'s project-property-backed `LinkStore` (FACTORY-5/8), routed by `link-store-router.ts` | ✗ absent |
| **jira-idea** | ✓ supported — same `AtlassianClient.search`/`searchAll`, filtered by `jiraIssueClass` (`src/resources/jira-idea.ts`) | ✓ supported — `createJiraIdeaClient.get()`, fail-closed type check | ✗ absent — no idea-specific event rules | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `JiraIdeaClient.comments`/`.addComment`, `get()`-then-act re-verification preserved on every write | ✗ **partial, declared false, re-verified FACTORY-25 — unchanged** — GitHub-issue remote links only (`linkedGithubIssues`/`linkGithubIssue`); no managed-link-store integration, and still excluded from `ResourceRef` (`link-store-router.ts` only routes owner keys `formatResourceRef` can produce, which `jira-idea` isn't one of) | ✗ absent |
| **confluence-page** | ✗ absent — `confluence-page-ref.ts` is pure identity/parsing, no live query | ✗ **partial, declared false** — `AtlassianClient.confluencePageVersion(pageId)` reads only `version.number`, never content; `get_doc`/`confluence_get_page` (a different subsystem, butchr's own MCP-doc tools) reads content but is not this interface | ✗ **partial, declared false** — `confluencePageVersion` is exactly the change-token hook `src/jira-watch/external-poll.ts` already uses | ✓ **supported (FACTORY-31/FACTORY-29)** — `readComments`/`addComment` (`src/resources/comments.ts`) over `AtlassianOps.commentOnPage`/`getPageComments` (`src/tools/atlassian.ts`/`atlassian-real.ts`), FOOTER comments only. Read body is storage-format XHTML as-is; write body is plain text, converted to storage XHTML by `comments.ts` itself. Ordering is sorted client-side (the server requests no `sort`); a missing/unusable id from `commentOnPage` is a documented honest rejection ("WAS posted... do not retry"), never a faked `CommentRef`. See "Design decisions for `confluence-page`" above | ✓ supported — one of `ResourceRef`'s seven kinds, generic file-backed `LinkStore` | ✗ absent |
| **github-issue** | ✓ supported — `createGithubIssueClient.searchAll` (`src/resources/github-issue.ts`) | ✓ supported — `.get()` | ✗ absent — no snapshot/diff/event-rules | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `GithubIssueClient.comments`/`.addComment` (the same client `github_add_comment`, a provider-specific MCP tool, already used) — `.addComment` re-reads the issue first, refusing a pull request or an issue outside `BUTCHR_GITHUB_ORGS` | ✓ supported — one of `ResourceRef`'s seven kinds | ✗ absent |
| **github-pr** (FACTORY-57) | ✓ supported — `createGithubPrClient.searchAll` (`src/resources/github-pr.ts`), forcing `is:pr` and rejecting a query shaped to ask for plain issues | ✓ supported — `.get()`, reading `/pulls/<n>` directly (never `/issues/<n>`, so — unlike `github-issue`'s own `.get()` — no separate "is this really a PR" field check is needed) | ✗ absent — no snapshot/diff/event-rules, same as `github-issue`; lifecycle at merge/close is query-driven (see `src/rules/github-pr-type.ts`'s own header — a merged/closed PR simply stops matching an `is:open`-style rule query, the same mechanism a closed issue already relies on for `github-issue`), not a capability this table tracks | ✓ **supported** — read/write PR comments via `github_get_pr`/`github_pr_add_comment` (`src/tools/github-pr.ts`), calling `GithubPrClient.comments`/`.addComment` directly (over the SAME issue-comments REST endpoint `github-issue` uses — a PR is an issue under GitHub's own data model), the same re-verification discipline as `github-issue` (`.addComment` re-reads via `.get()` first). NOT routed through `src/resources/comments.ts`'s shared `readComments`/`addComment` (that module remains `github-issue`-specific) — declared `true` here because the CAPABILITY is genuinely wired, via a sibling tool module rather than the shared entry point | ✓ supported — one of `ResourceRef`'s seven kinds; see `github-pr-ref.ts`'s own header for how it shares `github-issue`'s owner/repo#number identity shape (GitHub's own per-repo issue/PR number namespace) without colliding — the `github-issue:`/`github-pr:` canonical prefix carries the distinction | ✗ absent |
| **zendesk-ticket** | ✓ supported — `ZendeskTicketClient.searchAll` (`src/resources/zendesk-ticket.ts`) | ✓ supported — `.get()` | ✗ absent | ✓ **supported (FACTORY-25)** — `readComments`/`addComment` over `ZendeskTicketClient.comments`/`addInternalNote`; the write stays private-note-only (no public-reply path added), and a `null` note id from `addInternalNote`'s audit is a rejection that says the note WAS posted and must not be retried (never a faked `CommentRef`, never a silent "nothing happened") | ✗ **absent from the capability mechanism, re-verified FACTORY-25 — unchanged** — excluded from `ResourceRef`/`link-store`, so no managed-link path at all | ✗ absent |
| **filesystem** | ✓ **supported (FACTORY-26, re-truthed after BUTCHR-407)** — `listFilesystemResources` (`src/resources/filesystem.ts`) is a real, generic entry point: given a structured `FilesystemQuery` (`root`, `kind`, optional `namePattern`/`predicate`/`maxDepth`), it walks the tree and returns every matching resource, symlink-safe, capped (`MAX_VISITED`/`MAX_RESULTS`), same shape of query→results contract as `github-issue`'s `searchAll` or `jira-work-item`'s `search`/`searchAll`. `filesystem-ref.ts` (the OTHER, pre-existing `ResourceRef`-identity module of the same name — see that file's own header for the naming collision) is still pure path-identity/normalization; the query capability comes from `filesystem.ts`, not from it. | ✗ **partial, declared false** — `FilesystemResource` (the type `listFilesystemResources` returns) carries only `path`/`kind`/`name`/`size`/`mtimeMs`, never content; the one place file CONTENT is read (`readDefinitionFile`, `src/rules/session-definition-type.ts`) is internal to that one rule type's own manifest-parsing, not a generic `read(ref)` any zero-provider-knowledge caller could invoke — same "partial implementation only a provider-aware caller could use correctly" reasoning that keeps `jira-project`'s and `confluence-page`'s `read` cells `false` above | ✗ **partial, declared false** — `filesystem-type.ts`'s `createFilesystemResourceType`/`createFilesystemEventRules` DOES do a real (kind, size, mtime) poll/diff (appeared/disappeared/modified) with its own `runResourceLoop` wiring (`src/daemon/filesystem-loop.ts`), structurally the same shape as `github-issue-type.ts`'s and `zendesk-ticket-type.ts`'s own per-provider `createXEventRules` — but, like those two (both already declared `snapshot: false` above), this is the daemon's own internal per-provider agent-lifecycle plumbing (a bespoke `ResourceType<T>` invoked only by that provider's own bespoke loop-starter), not a shared, generically-invokable "give me a snapshot/diff" entry point a zero-provider-knowledge caller could call the way `readComments` works for `comments`. No such generic entry point exists for `filesystem` (or for any non-`jira-work-item` provider) today. **Flagged, not changed:** the evidence text for `jira-work-item`'s own `snapshot: true` above cites this exact same kind of code (`createIssueEventRules`, "the daemon's core poll/diff loop") as sufficient — under a strictly consistent reading of that same bar, `github-issue`/`zendesk-ticket`'s already-`false` `snapshot` cells look questionable too (both had equivalent `createXEventRules` diff wiring well before FACTORY-25 pinned them `false`). That inconsistency predates this ticket and touches rows outside its scope (FACTORY-26 owns only `filesystem`) — recorded here for whoever picks it up next, not resolved by this edit. | ✗ unsupported — no comment concept of any kind, nothing to reuse | ✓ supported — one of `ResourceRef`'s seven kinds (`filesystem-ref.ts`'s `ResourceRef`-identity half — see its header), routed through the generic file-backed `LinkStore` (`link-store-router.ts`); unaffected by BUTCHR-407 | ✗ absent |
| **webpage** | ✗ absent — `webpage-ref.ts` is pure URL-identity/canonicalization, no fetch code | ✗ absent | ✗ absent (`linked-discovery.ts` has a `webpage` `LinkedItemKind` — discovery classification, not a reader) | ✗ unsupported — no comment concept of any kind, nothing to reuse | ✓ supported — one of `ResourceRef`'s seven kinds | ✗ absent |

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
   `confluence-page` USED TO HAVE real, working, non-generic comment code
   (`AtlassianOps.commentOnPage`/`getPageComments`) that FACTORY-25 found but
   did not wire into the shared interface, for a materially different reason
   than "nobody's looked yet" (see "The comments capability" above: it needed
   a design decision about body format and dependency shape, not just
   mechanical wiring) — the same shape of gap FACTORY-23 had found and
   FACTORY-25 closed for `jira-idea`/`zendesk-ticket`/`github-issue`
   comments. FACTORY-29 made those two design decisions and FACTORY-31 wired
   them, closing `confluence-page`'s gap the same way. `jira-project`
   comments remains the one cell of this kind still open (no defined native
   referent at all, not merely unwired code — see the bullet above). This
   doc's deviation notes above exist specifically to keep that distinction
   visible in the record rather than collapsing every `false`/`true` flip
   into "someone got around to it."
3. **Some `false` cells are genuine gaps (jira-project comments has no defined
   meaning yet, needs product/design input from FACTORY-13) while others were
   pure scheduling (`jira-idea`/`github-issue`/`zendesk-ticket` comments — the
   code already existed, wiring was mechanical, closed by FACTORY-25) or a
   third kind — real code exists, but wiring it needs a design decision first,
   not purely mechanical work (`confluence-page` comments: FACTORY-25 found
   the code and flagged the design questions; FACTORY-29 answered them;
   FACTORY-31 wired it — now closed).** Treating all "false" cells
   identically would hide these differences from whoever plans the next
   story; this doc calls each one out per-cell instead.
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

**FACTORY-31 re-verification (2026-09-25):** `bun run check` — green end to
end: `3797 pass, 0 fail` (317 files), whole-project coverage 97.16%
lines/95.70% functions (minimum 90%), `verify-generated-is-committed` clean,
build succeeded. `confluence-page`'s `commentOnPage` return-shape claim above
was verified from CODE, not live Confluence: confluence.js 3.2.0's own
`FooterCommentSchema` (`node_modules/confluence.js/dist/v2/models/footerComment.js`,
this repo's pinned version) declares `id: z.string().optional()`, and
`createFooterComment` (`.../dist/v2/api/comment.js`) parses its response
through exactly that schema — re-verify against whichever `confluence.js`
version is actually installed before trusting this if it has moved. No live
Confluence call was made for this ticket.
