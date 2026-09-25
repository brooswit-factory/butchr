# Resource links: `ResourceRef`, the managed-link collection, and `list_links`/`add_link`/`remove_link`

FACTORY-7 (implementing FACTORY-4, story 1/3 of epic FACTORY-3 — "resource
links and project-level agents"). This is the foundation two shelved stories
build on: FACTORY-5 (a `jira-project` resource type persisting managed links
in the `brooswit.butchr.links` project property) and FACTORY-6 (reconciling
the effective link set into watchers, snapshots, and change events). Neither
is implemented here — this document exists so their authors have a stable,
documented surface to build against.

Background: [Handoff — Butcher Resource Links and Project-Level
Agents](https://wroosbit.atlassian.net/wiki/spaces/BROOSWITFACTORY/pages/39518269/Handoff+Butcher+Resource+Links+and+Project-Level+Agents)
— a contractor's recommendation, treated here as a starting point, not a
spec. Departures from it are called out explicitly below, with reasons.

## Scope

In scope: the `ResourceRef` type (six provider kinds), the managed-link
collection and its persistence, the `mergeEffectiveLinks` contract, and
`list_links`/`add_link`/`remove_link` as core functions, MCP tools, and a
`butchr link` CLI.

Explicitly **not** in scope, per the epic: a `jira-project` resource type
(agents-per-project), the `brooswit.butchr.links` project-property
persistence, any provider's native-link discovery, and reconciliation into
watchers/snapshots/events. Nothing here edits live daemon config or systemd
units.

## The six provider kinds

The epic's own scope list (authoritative over the handoff doc's longer
example list, which also names `jira-idea` and `zendesk-ticket` — both
excluded here on purpose, even though this repo already has resource types
for them):

| provider | identity payload | source module |
|---|---|---|
| `jira-work-item` | `{ key }` — a Jira issue key | `src/resources/jira-work-item-ref.ts` |
| `jira-project` | `{ key }` — a Jira project key | `src/resources/jira-project-ref.ts` |
| `confluence-page` | `{ pageId }` — a numeric page id | `src/resources/confluence-page-ref.ts` |
| `github-issue` | `{ owner, repo, number }` | `src/resources/github-issue-ref.ts` (existing, reused as-is) |
| `filesystem` | `{ path }` — an absolute path | `src/resources/filesystem-ref.ts` |
| `webpage` | `{ url }` | `src/resources/webpage-ref.ts` |

Each has its own module following this repo's existing `-ref.ts` convention
(`isXRef`/`formatXRef`/`parseXRef`, dependency-free, `null`-returning parse —
first established by `src/resources/github-issue-ref.ts` and
`zendesk-ticket-ref.ts`, reused rather than reinvented). `github-issue-ref.ts`
itself is untouched; every other module is new.

## Decision 1 — Schema and versioning

**A discriminated union on `provider`** (`src/resources/resource-ref.ts`),
one strict interface per provider, each independently validated by its own
`-ref.ts` module. `parseResourceRef(input: string): ResourceRef` throws a
specific, actionable message for both failure modes named in the ticket —
an unknown provider, and a provider-shaped-but-invalid payload — never a
generic "invalid input."

**The version tag lives on the persisted link COLLECTION
(`{ v: 1, links: {...} }`, `src/resources/link-store.ts`), not on the `ResourceRef`
type itself or on individual stored entries.** A ref's shape is pinned to the
format of the collection it's stored in; there is no per-ref version because
a ref is always read in the context of a collection that already carries one.

**Unknown-version handling: refuse to load, never guess.** `link-store.ts`'s
`readFile` throws if the stored `v` is greater than `LINKS_STORE_VERSION`
(currently `1`). Rationale: a future version may have changed what a stored
entry *means*, not merely added a field — silently reading it as v1 risks an
older writer corrupting a newer store on its very next write-back (`add_link`/
`remove_link` both do a full read-modify-write of the file). A version this
build understands is trusted fully.

**Unknown-provider handling: preserve-and-ignore, achieved structurally.**
Owner keys and target strings are stored and round-tripped as **plain
strings** — the persistence layer never parses them into a `ResourceRef`
except for the one owner/target a caller names in a given `list`/`add`/
`remove` call. A string this build's `resource-ref.ts` cannot parse (a
provider a newer writer already understands, or plain corruption) is
therefore left completely untouched by any operation that doesn't target it,
and is silently omitted — not deleted — from `listLinks`'s returned array.
See `test/unit/link-store.test.ts`'s "unknown-provider entries" suite for the
behaviour pinned: an unrecognised entry survives an `add_link` call for a
*different* resource in the same file, byte for byte.

## Decision 2 — Semantic labels: untyped for v1

No label field on a managed link. A link is a bare `(owner, target)` pair.

**Extension path, so this isn't a dead end:** the version rule above already
requires that adding a field to the collection format be additive-only within
one `v` — the same discipline would apply to a future `label` field: it must
be optional, so a `v: 1` store written by a label-aware build is still
readable by this build (an older reader simply never sees the field it
doesn't know about). Introducing a *required* label, or any change that
alters what an existing stored value means, is what `v` is for — bump it.

**Why not labels now:** the ticket's default recommendation was to stay
untyped for v1 unless there's a reason to diverge, and nothing in this
story's own scope (a foundation for FACTORY-5/6, not a UI) needs to
distinguish `documentation` from `depends-on` today. Deferred, not rejected.

## Decision 3 — Canonicalization and dedup

**Two refs are the same link iff their canonical strings
(`formatResourceRef`/`canonicalKey` — the same function, see the "one
mechanism, not two" note in `resource-ref.ts`'s header) are equal.** Per
provider:

- **`jira-work-item` / `jira-project`**: case-folded to uppercase. Built on
  the reused `isIssueKey`/`isProjectId` (`src/resources/id.ts`), which only
  match already-uppercase input — so the wrapper modules here upper-case
  *before* validating, giving case-insensitive dedup "for free" rather than
  rejecting a lowercase key outright.
- **`confluence-page`**: by page id alone, **not** `{space, pageId}` as the
  handoff doc's example shape suggests — a deliberate departure. A page's
  numeric id is Confluence's own stable identity; its space can change
  without the id changing, so including it would either duplicate the id or
  go stale next to it. `parseConfluencePageRef` accepts a bare id or a full
  page URL (reusing `pageIdFromUrl`, `src/tools/docs.ts` — not a second
  regex), but the canonical form is always the bare id.
- **`github-issue`**: `owner/repo#number`, owner/repo lower-cased — reuses
  `formatGithubIssueRef`/`parseGithubIssueRef` unchanged.
  `resource-ref.ts`'s own parsing additionally falls back to
  `githubIssueRefFromUrl` when the bare canonical form doesn't parse, so a
  pasted GitHub issue URL (any case) also case-folds correctly — the only
  path by which a `github-issue` ref case-folds at all, since
  `parseGithubIssueRef` itself never does (see that module's own header).
- **`filesystem`**: absolute path, `.`/`..` segments and duplicate slashes
  normalized, trailing slash stripped (except root). **Not** case-folded —
  unlike a GitHub owner/repo, a Unix path is case-sensitive, so folding case
  would incorrectly conflate two different files. No symlink resolution
  either (would require a live filesystem read; identity parsing must not
  depend on what happens to exist on disk right now).
- **`webpage`**: scheme and host lower-cased, default port stripped,
  fragment stripped, trailing slash stripped (except bare root). **Query
  string kept byte for byte, tracking parameters included** — deciding which
  parameters are tracking-irrelevant is provider-specific and easy to get
  wrong in either direction; left unresolved on purpose. Path case is
  preserved (paths are case-sensitive in general; hosts are not).

**Known aliasing deliberately NOT resolved**, named per the ticket's own
example: a `webpage` ref and a `confluence-page` ref pointing at the *same
real Confluence page* do **not** dedup against each other —
`webpage:https://…/wiki/spaces/X/pages/123456/Title` and
`confluence-page:123456` produce different canonical keys
(`test/unit/resource-ref.test.ts` pins this as a named non-equivalence, not
an oversight). Resolving it would mean either every `webpage` ref pays the
cost of checking "is this secretly a Confluence URL", or `confluence-page`
becomes reachable through two different canonical forms — both rejected as
unnecessary complexity for what a caller can trivially avoid by using the
right provider up front.

**One naming/overlap note, worth being explicit about:** this codebase
already has a `ResourceProvider` type (`src/rules/agent-key.ts`) for a
*different* set — the providers a *rule* can staff an agent for
(`"jira-work"`, `"github-issue"`, `"jira-project"`, `"jira-idea"`,
`"zendesk-ticket"`). Note the string itself differs (`"jira-work"` there vs.
`"jira-work-item"` here) and the member sets differ in both directions. This
module's discriminant is named `ResourceRefProvider` specifically so the two
never collide or get confused for each other in an import list. Separately,
`src/resources/resource-link.ts` (resolves a dashboard row to a browse URL)
and `src/resources/types.ts`'s `RelatedResource<T>` (the poll loop's
Implements-chain mechanism) are **not** the same concept as the managed-link
collection either, despite similar names — neither is touched by this story.

## Decision 4 — Recursion: direct only, enforced structurally

A link only ever creates a sensor for the directly-linked resource. It never
causes discovery of *that* resource's own links, and never creates an agent
— the handoff doc's own separation ("queries decide which resources get
agents; links decide which resources those agents can sense").

This is enforced by `mergeEffectiveLinks`'s own **signature**
(`src/resources/managed-links.ts`), not by a comment someone could later
violate without the type system noticing: it takes two flat `ResourceRef[]`
arrays and returns a flat array. There is no resource resolver, no provider
client, and no recursive call anywhere in its body — there is no code path
by which it *could* follow a target's own links without first changing this
signature, which a reviewer would see in the diff.

## Decision 5 — The merge contract

`mergeEffectiveLinks(native, managed): EffectiveLink[]` combines a resource's
provider-native links (not implemented by any provider in this story) with
its managed links into one set, each entry tagged with its `origin`:
`"native"`, `"managed"`, or `"both"` (present in both source lists).

**Ordering contract**, deterministic and tested: native refs first (in
`native`'s own order), then managed-only refs not already present, in
`managed`'s own order. A duplicate *within* one source list alone (e.g. two
equivalent managed entries) collapses to one entry of that list's own origin
— it is not promoted to `"both"` just for repeating (a real bug caught by
this story's own tests before it shipped; see `mergeEffectiveLinks`'s
`nativeKeys` tracking).

**This story does not implement any provider's `nativeLinks` discovery.**
`mergeEffectiveLinks` is what's being shipped and tested now, ready for
FACTORY-6 to call once a real `native` array exists from a real adapter.

## Decision 6 — Poll cadence / change tokens: extension point only

`ProviderAdapter<Ref>` (`src/resources/provider-adapter.ts`) declares
`canonicalize`, an optional `nativeLinks`, and an optional `changeToken` —
nothing in this codebase constructs one today. Recommended per-provider
`changeToken` strategies are documented there as **guidance only**, nothing
built or wired:

- `jira-work-item`/`jira-project`: `updated` timestamp + comment count.
- `confluence-page`: `version.number`.
- `github-issue`: `updated_at`, or the response ETag.
- `filesystem`: mtime + size.
- `webpage`: `ETag`, falling back to `Last-Modified`.

## Decision 7 — Persistence: provider-agnostic local JSON store

A single JSON file (`{ v: 1, links: { "<ownerKey>": ["<targetKey>", ...] } }`)
under `join(workspaceRoot(), ".links.json")` (overridable via
`BUTCHR_LINKS_STORE_FILE`) — **not** a Jira project property, which is
`jira-project`-specific persistence belonging to FACTORY-5. This is a real,
tested implementation, not a stub: any resource kind can use it, and
FACTORY-5's own tests can build on it directly rather than needing a live
Jira project to test against.

`LinkStore`'s methods are `Promise`-returning even though this
implementation is synchronous underneath, so a future network-backed
implementation (FACTORY-5's Jira REST project property) can satisfy the same
interface without a breaking signature change.

**Atomic write** (temp file + rename), unlike this repo's existing
`capture-store.ts` (plain `writeFileSync`) — deliberate, because this file is
the durable source of truth for a resource's links, written by both an
operator's CLI and the daemon's own MCP handlers. **Named limitation**: this
prevents a crash mid-write from corrupting the file into invalid JSON; it
does **not** solve a concurrent read-modify-write race (two callers both read
before either writes — the second write wins). Accepted for a store this
lightly written to; a real multi-writer lock is out of scope.

## Decision 8 — Self-links and idempotency

- **A resource may not link to itself.** Enforced by comparing canonical
  keys in `addLink` — refused with a clear error, never silently accepted or
  silently dropped.
- **`add_link` is idempotent**: adding an already-present link is a no-op,
  reported via `{ added: false, reason: "already-present" }`, never an error.
- **`remove_link` of an absent link is non-destructive**: reported via
  `{ removed: false, reason: "not-present" }`, never an error.

## The operations: core, MCP, CLI

All three layers share one implementation
(`listLinks`/`addLink`/`removeLink`, `src/resources/link-store.ts`) — the MCP
tools (`src/tools/resource-links.ts`) and the CLI (`src/cli/link-cli.ts`) are
thin wrappers, neither reimplements the logic.

**Everywhere, a `ResourceRef` is written as its canonical `<provider>:<id>`
string** — on CLI argv, as MCP tool arguments, and in the on-disk store. One
encoding, not a string form for the CLI and a structured-object form for MCP.

`list_links`/`add_link`/`remove_link` operate on the **butchr-managed**
collection only. This is deliberate, not an oversight: the handoff doc frames
these as controlling "the agent's own sensor set", and a managed link is
exactly what an agent (or operator) can add/remove — a native link is
discovered, not added or removed through this API. `list_links` therefore
does **not** perform the `mergeEffectiveLinks` merge (there is nothing to
merge yet — no adapter supplies `native`); a future reconciler is what calls
`mergeEffectiveLinks` once one does.

**MCP tools take an explicit `resource` argument**, unlike
`github_get_issue`/`zendesk_get_ticket`/etc., which scope to the caller's own
identity. Deliberate departure: three of the six provider kinds
(`confluence-page`, `filesystem`, `webpage`) have no agent/caller-identity
concept anywhere in this codebase (`src/mcp/identity.ts`'s `CallerIdentity`
union has no such member for them) — "the caller's own resource" is simply
not an answerable question for them. An explicit argument also matches the
handoff doc's own signature, `list_links(resource)`, literally, and is
registered **unconditionally** (unlike every provider-specific tool set),
since the local store needs no credentials and works for every kind.

CLI: `butchr link list <resource>`, `butchr link add <resource> <target>`,
`butchr link remove <resource> <target>`, plus `--help`/`-h`. Non-zero exit
(1) on a missing/unknown subcommand, wrong argument count, an unparseable
reference, or a self-link attempt; exit 0 for every other outcome, idempotent
no-ops included, since those are not errors.

`package.json`'s `bin.butchr` builds solely from `src/daemon/index.ts` — this
is the first subcommand this binary has ever had, so `runLinkCli` is invoked
from a small `argv[2] === "link"` guard at the very top of that file, before
its config/rules loading, so a `butchr link` invocation needs no Jira
credentials or rules file.

## What FACTORY-5/FACTORY-6 should consume

The stable exported surface, expected not to change shape without a
conversation with whoever is building against it:

- `src/resources/resource-ref.ts`: `ResourceRef`, `ResourceRefProvider`,
  `RESOURCE_REF_PROVIDERS`, `parseResourceRef`, `tryParseResourceRef`,
  `formatResourceRef`, `canonicalKey`.
- `src/resources/managed-links.ts`: `mergeEffectiveLinks`, `EffectiveLink`,
  `LinkOrigin`.
- `src/resources/provider-adapter.ts`: `ProviderAdapter<Ref>` — FACTORY-6's
  own adapters implement this per provider.
- `src/resources/link-store.ts`: `LinkStore` (the interface — FACTORY-5 can
  implement its own project-property-backed version of it),
  `createLinkStore`/`defaultLinksStorePath` (the provided local
  implementation), `listLinks`/`addLink`/`removeLink` (the core operations —
  reusable directly by any future in-process caller, not only the MCP/CLI
  wrappers in this story).

FACTORY-5 does not have to use `createLinkStore`'s file-backed
implementation for `jira-project` resources — it only has to satisfy
`LinkStore`'s interface so `listLinks`/`addLink`/`removeLink` keep working
unchanged over whatever persistence it builds.

## Verification

- `bun run typecheck` — clean.
- `bun test test/unit test/load` — full existing suite plus this story's new
  tests, 0 failures.
- `bun run scripts/coverage/gate.ts` — project-wide coverage stayed above the
  90% line/function minimum.
