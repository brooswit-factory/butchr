# Resource links: `ResourceRef`, the managed-link collection, and `list_links`/`add_link`/`remove_link`

FACTORY-7 (implementing FACTORY-4, story 1/3 of epic FACTORY-3 — "resource
links and project-level agents") laid this foundation. Two more stories build
on it: FACTORY-5 (a `jira-project`-owned managed-link collection persisted in
the `brooswit.butchr.links` project property, wired into
`list_links`/`add_link`/`remove_link` — implemented below, see Decision 9)
and FACTORY-6 (reconciling the effective link set into watchers, snapshots,
and change events — still not implemented; this document remains the stable,
documented surface its author builds against).

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
`jira-project`-specific persistence, implemented separately in Decision 9
below (FACTORY-5) and routed to only for a `jira-project:<KEY>` owner. This
file store is a real, tested implementation, not a stub, and remains the
persistence for every OTHER owner kind: FACTORY-5's own tests build on it
directly (see Decision 9) rather than needing a live Jira project to test
against.

`LinkStore`'s methods are `Promise`-returning even though this
implementation is synchronous underneath, so a network-backed implementation
(FACTORY-5's Jira REST project property, Decision 9) can satisfy the same
interface without a breaking signature change.

The CLI resolves the store via the SAME `defaultLinksStorePath()`
(`workspaceRoot()`/`BUTCHR_LINKS_STORE_FILE`) the daemon uses — an operator
must run `butchr link ...` with the same environment (`BUTCHR_WORKSPACES`/
`BUTCHR_LINKS_STORE_FILE`) as the daemon it's inspecting to see the same
store; a different shell environment silently resolves to a different file
rather than failing loudly, since a missing store file is a normal, valid
empty state, not an error.

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

## Decision 9 — `jira-project` persistence and owner routing (FACTORY-5)

**A second `LinkStore` implementation, backed by the Jira project entity
property `brooswit.butchr.links`** (`src/resources/jira-project-link-store.ts`,
`createJiraProjectLinkStore(ops: AtlassianOps): LinkStore`) — used for a
`jira-project:<KEY>` OWNER only; every other owner kind keeps using the
file store from Decision 7 unchanged. The property key is namespaced
`brooswit.` because project-property keys are shared across whatever apps a
project has, not just this daemon; `.butchr.links` distinguishes it from the
unrelated `butchr` property `src/resources/project.ts` already owns for this
daemon's own project-tier wake watermarks — a different concern, deliberately
not reused or extended, so a link-heavy project can never starve the
project's own wake bookkeeping of space (or vice versa).

**Value shape:** `{ v: 1, links: ["<targetCanonicalKey>", ...] }` — a FLAT
array, not the file store's `{ v: 1, links: { "<ownerKey>": [...] } }` map.
Deliberate departure from the file store's shape: a Jira project property
read/write call is already scoped to exactly one project (`projectKey` is an
argument to the Jira API call, not data inside the value), so there is
exactly one owner a given property value could ever describe — a map keyed
by an owner that never varies would just be a wrapper around one entry.
`list`/`add`/`remove` still take the SAME full canonical `ownerKey` string
(e.g. `"jira-project:BUTCHR"`) every `LinkStore` method already receives;
this implementation asserts that key names the same project the property
call targets rather than storing it.

**Same discipline as the file store, restated independently (this is a
second, independent implementation, not a shared code path):** `v` refuses
to load a version newer than this build supports (today, only `1`) rather
than guess. Target strings are round-tripped as plain strings, never parsed
into a `ResourceRef` at this layer — achieved structurally, the same way the
file store achieves it: an entry this build's `resource-ref.ts` can't parse
survives an `add`/`remove` of a DIFFERENT target in the same property, byte
for byte (pinned by `jira-project-link-store.test.ts`'s "unknown-provider
(unparseable) entries" suite). Missing property (`getProjectPropertyOrNull`
resolving `null`, i.e. a genuine Jira 404) is treated as `{ v: 1, links: [] }`
— an empty collection, not an error; any OTHER read/write failure (a
permission error, a network error, a malformed value) propagates uncaught.

**Atomicity / race window, NAMED:** `add`/`remove` are a read-modify-write of
the FULL property value (`getProjectPropertyOrNull` then
`setProjectProperty`, a full-value REPLACE — Jira's project property API has
no compare-and-swap, no partial update, no ETag/version precondition). Two
concurrent callers (two agents, or an agent racing an operator's CLI) can
both read the same starting value before either writes; the second write
wins and the first caller's change is silently lost. Same judgment as
Decision 7's own, differently-caused race: accepted for a collection this
lightly written to relative to how often it's read; a real fix needs
Jira-side optimistic locking this API does not expose.

**Size cap:** a Jira project entity property value is capped at 32768 bytes
(the same platform-wide ceiling `src/resources/project.ts`'s
`PROJECT_PROPERTY_SIZE_CEILING_BYTES` independently documents and enforces
for its own, unrelated property). `createJiraProjectLinkStore`'s `add`
refuses with a clear, thrown error naming the actual byte count rather than
risking a silent Jira-side truncation or rejection; `remove` can only shrink
the value, so it is not checked.

**Credentials / permissions, honestly stated:** `src/resources/project.ts`
MEASURED live (2026-09-01) that this daemon's own credential can write a
project entity property it does not lead, gated on Jira's Administer
Jira/Projects grant rather than project leadership — but that measurement is
against the OTHER (`butchr`) property. This story has NOT independently
re-measured `brooswit.butchr.links` specifically against a live project; it
is the SAME Jira REST endpoint and expected to carry the same permission
model, but "expected to match" is stated here as exactly that, not as a
second live measurement. See this story's PR description for what was
actually verified live, if anything, against a scratch project property
(created and deleted for the purpose — `brooswit.butchr.links` is not left
on any real project by this story's own verification).

**Owner routing — one small, testable function, not scattered ifs**
(`src/resources/link-store-router.ts`, `createRoutingLinkStore`): given a
file store and a LAZY `jiraProjectStore` factory, every `list`/`add`/`remove`
call checks whether its `ownerKey` starts with `jira-project:` and delegates
to whichever store applies. The factory is a factory, not a value, and is
invoked ONLY when a call actually routes to a `jira-project:` owner — this is
what lets the CLI build a routing store without needing Jira credentials for
the common (non-`jira-project`) case. `listLinks`/`addLink`/`removeLink`
(`src/resources/link-store.ts`) are UNCHANGED by this story: routing happens
entirely in which `LinkStore` value they're handed, never inside those three
functions. The daemon (`src/daemon/index.ts`) wires the routing store into
`resourceLinkTools` (MCP) unconditionally — it already has Jira credentials
loaded at that point, so its `jiraProjectStore` factory is cheap and
side-effect-free, not genuinely lazy.

**CLI credential loading (`src/cli/link-cli.ts`):** `butchr link ...` for any
NON-`jira-project` owner still needs no Jira credentials or rules file,
exactly as Decision 7 describes — unaffected by this story. A `jira-project`
owner's `jiraProjectStore` factory (`jiraProjectStoreFromEnv`) calls the
SAME `loadConfig` (`src/config/config.ts`) the daemon itself uses, reading
`ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN`(`_FILE`) from the
CLI invoker's own environment — an operator must run `butchr link ... jira-project:X ...`
with the same Jira credentials the daemon would use, the same discipline
Decision 7 already documents for `BUTCHR_WORKSPACES`/`BUTCHR_LINKS_STORE_FILE`.
A missing/invalid credential, or a Jira 4xx/5xx the resulting call hits,
surfaces through the EXACT SAME path a file-store read failure already did
before this story: `tryStoreOp` (link-cli.ts) turns any rejected store call
into one clean `stderr` line and exit 1 — no separate error-handling branch
was added for this case.

**Targets of any kind, self-links, idempotency:** unchanged and inherited
for free. A `jira-project` owner's targets may be any of the six
`ResourceRef` kinds (nothing in `createJiraProjectLinkStore` restricts
target shape). Self-link refusal, idempotent `add`, and non-destructive
`remove` (Decision 8) are enforced in `addLink`/`removeLink`
(`link-store.ts`) BEFORE either implementation's `store.add`/`store.remove`
is ever called, so both stores get this behaviour identically without
reimplementing it.

**`ProviderAdapter.nativeLinks` for `jira-project`:** untouched by this
story — nothing in this codebase constructs a `ProviderAdapter` at all yet
(Decision 6), so there was nothing to omit or stub.

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
since the daemon already has Jira credentials loaded regardless of which
owner kind a given call names (Decision 9's routing is invisible from here —
the daemon's own `jiraProjectStore` factory is cheap, not genuinely lazy).

CLI: `butchr link list <resource>`, `butchr link add <resource> <target>`,
`butchr link remove <resource> <target>`, plus `--help`/`-h`. Non-zero exit
(1) on a missing/unknown subcommand, wrong argument count, an unparseable
reference, or a self-link attempt; exit 0 for every other outcome, idempotent
no-ops included, since those are not errors.

`package.json`'s `bin.butchr` builds solely from `src/daemon/index.ts` — this
is the first subcommand this binary has ever had, so `runLinkCli` is invoked
from a small `argv[2] === "link"` guard at the very top of that file, before
its config/rules loading. A `butchr link` invocation for any NON-`jira-project`
owner still needs no Jira credentials or rules file, exactly as before this
story; a `jira-project` owner is the one exception, needing Jira credentials
from the CLI invoker's own environment — see Decision 9's "CLI credential
loading" for exactly how and why that's still lazy.

## What FACTORY-6 should consume

FACTORY-5 (Decision 9) is implemented; FACTORY-6 (reconciling the effective
link set into watchers, snapshots, and change events) is not. The stable
exported surface, expected not to change shape without a conversation with
whoever is building against it:

- `src/resources/resource-ref.ts`: `ResourceRef`, `ResourceRefProvider`,
  `RESOURCE_REF_PROVIDERS`, `parseResourceRef`, `tryParseResourceRef`,
  `formatResourceRef`, `canonicalKey`.
- `src/resources/managed-links.ts`: `mergeEffectiveLinks`, `EffectiveLink`,
  `LinkOrigin`.
- `src/resources/provider-adapter.ts`: `ProviderAdapter<Ref>` — FACTORY-6's
  own adapters implement this per provider.
- `src/resources/link-store.ts`: `LinkStore` (the interface),
  `createLinkStore`/`defaultLinksStorePath` (the file-backed implementation,
  Decision 7), `listLinks`/`addLink`/`removeLink` (the core operations —
  reusable directly by any future in-process caller, not only the MCP/CLI
  wrappers).
- `src/resources/jira-project-link-store.ts`: `createJiraProjectLinkStore`
  (the project-property-backed `LinkStore`, Decision 9).
- `src/resources/link-store-router.ts`: `createRoutingLinkStore`,
  `isJiraProjectOwnerKey` — the owner-routing decision (Decision 9), reusable
  by any future caller that needs the same file-vs-project-property split
  FACTORY-6 will likely also need for its own per-provider persistence
  questions.

## FACTORY-9 (implements FACTORY-6, story 3/3): effective links reconciled into watchers

This section describes what actually shipped for FACTORY-6's scope — merging
effective links, reconciling them into watchers, caching snapshots, and
emitting change events (comments included) via the EXISTING BUTCHR-436/437
linked-eventing notify path (`src/jira-watch/linked-eventing.ts`). No second
notification mechanism was built; every piece below extends that module's
existing coalescer, per-(owner,target) baseline store, and
`maxLinkedTurnsPerHour` rate cap in place.

**Scope, today: `jira-work-item` owners only.** The only live owner
`createRuleResourceType`'s `runTick` call runs for is a `jira-work-item`
(`RuleMatch`) — FACTORY-5's `jira-project` resource type is a separate,
not-yet-merged resource type (its own poll loop), untouched by this story.
The reconciliation itself (`src/resources/link-reconcile.ts`) is
provider-agnostic on the TARGET side, so a future `jira-project` (or any
other) owner can reuse `managedLinkedItems` unchanged once it exists.

**How a managed link becomes a watcher.** Each opted-in (`linkedEventing:
true`) owner's own native Jira links (`nativeJiraRefs`: its `issuelinks` and
`parent`, already-fetched data, zero new API calls — deliberately NOT remote
links or description mentions, which stay `jiraKindLinkedItems`'s/
`descriptionLinkedItems`'s own opt-in, cost-gated features) are merged
against its FACTORY-4 managed links (`LinkStore.list`) via
`mergeEffectiveLinks`, honouring the merge/dedup contract above. Only a
`"managed"`-origin link (i.e. NOT already covered by native discovery)
becomes a NEW watched item — a managed link duplicating an existing
issuelink produces no second watcher and no double event for the same
target; the existing native-discovery item (`kind: "issuelink"`) still wins.
A managed-origin link's `ResourceRef` maps onto the EXISTING `LinkedItemKind`
taxonomy so it rides the SAME diff/poll path a natively-discovered link of
that kind already uses:

| `ResourceRefProvider` | `LinkedItemKind` | reuses |
|---|---|---|
| `jira-work-item` | `jira-key` | the existing Jira batched-search status/summary/updated diff, now comment-aware (below) |
| `confluence-page` | `confluence` | `pollConfluencePage` — extended to accept the ref's own BARE page id, not only a URL |
| `github-issue` | `github-issue` | `pollGithubLink` unchanged — the canonical `owner/repo#n` string is already the exact identity it expects |
| `webpage` | `webpage` | `pollWebpage` unchanged — the ref's own normalized URL is already what it expects |
| `filesystem` | `filesystem` (NEW) | a new poller, `pollFilesystem` (`src/jira-watch/external-poll.ts`) — `fs.stat`'s mtime+size, no network |
| `jira-project` | — | **explicit, documented scope gap**: no live Jira API call exists anywhere in this codebase for a PROJECT's own change signature, and FACTORY-5 (which would give one a live agent) is not merged. Silently excluded from every owner's watch set — never a crash, logged once, the same effect as an omitted `ProviderAdapter.changeToken` |

**Reconcile is idempotent, every tick.** Managed items are combined with
native/description items BEFORE `maxLinkedItems` caps (one uniform budget
across every kind, unchanged) and reduce, via the SAME removed-link diff
`linked-eventing.ts` already ran, to: newly-present → new watcher (first
sighting seeds the baseline silently, no event); no-longer-present → "no
longer linked" (fires once); unchanged → nothing. **New in this story:** a
removed target's baseline (and unreadable-transition state) is now actually
DELETED, not merely left stale — `baselines`/`unreadableOwners` previously
had no entry-eviction path at all for a single removed link (only for an
owner leaving the matched set entirely, which stays intentionally unbounded
— see that section's own comment), so re-adding the same link later would
have diffed against a stale pre-removal snapshot and fired a spurious
"changed" event instead of reseeding. Fixed for every kind, not only managed
links (native/description-driven removals get the same fix for free) —
covered by `test/unit/linked-eventing-managed-links.test.ts`'s own
add→remove→re-add test.

**Comment detection.** The pre-FACTORY-9 Jira-kind snapshot diffed only
status/summary/updated/labels — a new comment WAS already visible (Jira
bumps `updated` when a comment lands) but rendered only as a bare "updated",
indistinguishable from any other field this diff doesn't track (priority,
due date, …). `JiraSnapshot` now carries an optional `commentCursor` (the
target's newest comment id, `undefined` meaning "not checked this tick") —
populated by a NEW per-target `deps.comments` call (Jira has no batched
comments endpoint, so this is a genuinely new per-tick REST cost, one call
per DISTINCT Jira-kind target, bounded by the same `mapLimit` concurrency
helper the three BUTCHR-437 pollers already use), fed into the SAME
`changeDetail` that renders `linkedChangeNudge`'s per-event line: a comment
add renders `"got a new comment"`, a comment deletion (BUTCHR-351 precedent)
renders `"had a comment removed"`, taking priority over the generic
"updated" fallback but not over an explicit status change. Omitting
`deps.comments` reproduces the exact pre-FACTORY-9 behaviour (never wired,
never a new call) — every existing test that doesn't set it is unaffected.

**The FACTORY-1 regression class, re-proven for this new path.** FACTORY-1
(investigated, not reproducible — see that ticket) already established that
the `related:` (Implements-chain boss/worker) notify path is architecturally
independent of `linked:`'s rate cap: `discovery.related()`'s return value is
built from `relatedForRules` BEFORE `linkedEventingState.runTick` ever runs,
and `runTick` only ever performs its OWN `deps.notify` call under its OWN
`turns` budget. This story doesn't touch `related()`/`relatedForRules` at
all — only `runTick`'s item-gathering — so that independence holds for the
managed-link path unchanged, structurally, by construction. Re-proven with a
dedicated test (`test/unit/linked-eventing-managed-links.test.ts`,
"FACTORY-9 / FACTORY-1 regression class") that exhausts an owner's
`maxLinkedTurnsPerHour` budget with unrelated MANAGED-link churn (not
native/description churn, which FACTORY-1's own test already covers) and
then shows: (a) a rate-capped managed-link change is retried on the next
allowed tick, never silently dropped (the pre-existing "advance only on
success" discipline, unchanged, now also covering managed items), and (b) a
cross-daemon Epic still receives exactly one `related:` notify for its
Story's move to In Review, the instant it happens, budget exhaustion
notwithstanding.

**Wiring.** `src/daemon/index.ts` passes `linkStore: createLinkStore(defaultLinksStorePath())`
(the same local store `resourceLinkTools` already exposes as MCP tools — a
second, stateless handle onto the same file) and `filesystem: { stat }` to
`createRuleResourceType`; `comments: atlassian.comments` was already wired
for a different purpose (an OWN issue's own notify reason) and is now also
forwarded into `runTick`. Every one of these is optional, following this
module's existing "omitted dep ⇒ feature silently never runs" convention —
a daemon that doesn't wire `linkStore` reconciles no managed links at all,
byte-for-byte the pre-FACTORY-9 behaviour.

## Verification

- `bun run typecheck` — clean.
- `bun test test/unit test/load` — full existing suite plus this story's new
  tests, 0 failures.
- `bun run scripts/coverage/gate.ts` — project-wide coverage stayed above the
  90% line/function minimum.
