# `filesystem`: local files and directories

`filesystem` is its own resource provider (BUTCHR-407, story BUTCHR-393,
epic BUTCHR-391). A rule names a small JSON query selecting files or
directories under one root; each matching resource gets one agent per rule,
keyed `filesystem:<ruleId>:<canonical-path>` and working in
`<workspace root>/filesystem/<ruleId>/<percent-encoded-path>`.

Unlike `github-issue`/`zendesk-ticket`, `filesystem` needs no external
credential and no staffing gate: every enabled `filesystem` rule always
runs, reading the local disk the daemon's own process already has.

## Query syntax decision

Every other provider's `Rule.query` is a plain STRING: JQL for `jira-work`/
`jira-idea`, GitHub issue search syntax for `github-issue`, Zendesk search
syntax for `zendesk-ticket`. There is no precedent anywhere in the schema
for a structured field on `Rule` itself, and widening `Rule.query`'s type
would touch every provider's own validation branch for one provider's
benefit.

A filesystem query needs several independent, typed axes (root, file vs.
directory, a name glob, a recursion depth, an optional content/metadata
predicate) that a hand-rolled mini-language would only re-encode clumsily.
**Decision: the query is a small JSON object, serialized into that same
string field and parsed at rule-load time** (`src/resources/filesystem-query.ts`)
— structured data riding the existing string-only schema, not a new
mini-language and not a schema change. This mirrors the ticket's own stated
preference ("prefer a small structured (JSON) query... unless the existing
providers' query field is string-only") applied literally: the field stays
string-typed for every provider, and `filesystem` alone puts JSON in it.

```json
{
  "root": "~/repo/docs",
  "kind": "file",
  "namePattern": "*.md",
  "maxDepth": 4,
  "predicate": { "predicateKind": "extension", "value": ".md" }
}
```

| field | required | meaning |
|---|---|---|
| `root` | yes | Absolute path, or `~`/`~/rest` (expanded against the daemon's `$HOME`; a bare `~user` form is refused — no passwd lookup is ever performed). No `.`/`..` segments, no repeated slashes, no trailing slash (except the bare `/`), under 4096 characters. **Never itself a candidate resource** — only its descendants are. |
| `kind` | yes | `"file"` or `"directory"` — whether matching resources are files or directories. A rule matches exactly one kind; write two rules to watch both. |
| `namePattern` | no | A glob (`*`, `?`; no `/`, no `**`, no brace or character-class syntax) matched against the candidate's OWN basename only — never the full relative path. Absent matches every name. |
| `maxDepth` | no | Integer, 1–64 (`MAX_ALLOWED_DEPTH`). How many directory levels below `root` to descend; `root`'s own direct children sit at depth 1. Defaults to 64 when absent. |
| `predicate` | no | A content/metadata filter, one of the two shapes below. |

**Predicates** (`FilesystemPredicate`, one of):

- `{ "predicateKind": "extension", "value": ".ts" }` — "files whose extension
  is Y". Requires `kind: "file"`. `value` must start with `.`, contain no
  `/` or whitespace. Matching is a case-sensitive suffix check
  (`path.endsWith(value)`), so a file literally named `.ts` (no basename
  before the dot) also matches `.ts`, and `.TS`/`.Ts` do not match `.ts`.
- `{ "predicateKind": "hasEntry", "name": "README.md", "entryKind": "file" }`
  — "directories containing a file/directory named X". Requires
  `kind: "directory"`. `name` is a direct-child name (no `/`, not `.`/`..`);
  `entryKind` (`"file"` or `"directory"`) is optional — omitted, either kind
  of child named `name` satisfies it.

A bad query (invalid JSON, an unknown field, a wrong-kind predicate, an
out-of-range `maxDepth`, …) is rejected at rule-load time with every problem
named, same style as `github-issue`/`zendesk-ticket`:

```
rules[2].query: query.root must be absolute (or start with ~)
rules[2].query: query.predicate: an "extension" predicate requires query.kind "file"
```

Root **existence** is deliberately NOT checked here — that is a
discovery-time fact (see "Safety" below), not a load-time one, so a root
that is temporarily unmounted fails a POLL, never the daemon's own startup.

## Resource identity

A resource's id is its canonical absolute path
(`src/resources/filesystem-ref.ts`), resolved through `realpath` by
discovery before it is ever used — so a `root` reached through a symlink,
or two rules naming the same real directory through different spellings,
resolve to the SAME id and the same agent. The id is percent-encoded like
every other provider's native id in the agent key
(`filesystem:<rule>:%2Fhome%2F...`) and as the workspace directory segment.

**The real limit is 255 encoded BYTES, not a raw character count.**
`workspaceDirFor` makes the whole percent-encoded id ONE directory-name
component, and every mainstream Linux filesystem caps a single component at
`NAME_MAX` = 255 bytes. Percent-encoding inflates size — every `/` becomes
`%2F` (3 bytes), every non-ASCII character becomes 6+ bytes — so a path that
looks like a perfectly ordinary absolute path can still overflow that limit;
a short but heavily non-ASCII path can overflow it even though a much longer
plain-ASCII one might not. `isFilesystemResourceId` checks
`Buffer.byteLength(encodeURIComponent(id), "utf8") <= MAX_ENCODED_SEGMENT_BYTES`
directly (`src/resources/filesystem-ref.ts`) — this is the one check that
matters; there is no separate raw-character-count cap, because one would
either be laxer than this (and miss real overflows) or redundant with it.
A resource whose id fails this check is **skipped, not staffed, and never
crashes the poll**: `searchFilesystemRules` (`src/rules/filesystem-type.ts`)
drops it before it ever reaches `encodeAgentKey`, logging
`WARNING: [filesystem] rule <id> skips <path>: ...` once per (rule, path) —
every other resource that rule's query matched is staffed normally. Deep
trees (monorepos, `node_modules`, nested project directories) reach this
realistically; narrow the rule's `root` or `namePattern` if you see it.

## Discovery, and what "matches" means

Each poll, a rule's query walks `root` (`src/resources/filesystem.ts`):
canonicalize `root` via `realpath`, then recurse breadth-first-in-spirit
(actually depth-first, order unspecified) up to `maxDepth`, testing every
directory entry against `kind`, `namePattern` and `predicate`. `root` itself
is never a candidate — only what's found beneath it.

## Change events

Discovery re-walks the whole tree every poll (no OS-level `fs.watch`,
BUTCHR-407 requirement 3 explicitly allows polling) and diffs the (kind,
size, mtime) of each still-matched resource against the previous poll —
deterministic under test via an injectable `FilesystemIo`
(`src/resources/filesystem.ts`), never a sleep-and-hope.

**Swarm** (`execution: "swarm"`, the default): a resource entering or
leaving the query spawns or stops its own agent — no separate notify for
that (the spawn/stop already says it). A resource that STAYS matched but
whose kind/size/mtime moved (a modify) notifies its own agent, naming no
more specific reason than "was updated" (filesystem has no Jira-shaped
`NotifyReason` member — see `src/resources/types.ts`'s own doc comment).
This mirrors `github-issue`/`zendesk-ticket`'s own precedent for PRIMARY
notifications, not `jira-work`'s (which notifies appear/disappear too, for
reasons specific to its Implements-chain routing — see
`src/rules/filesystem-type.ts`'s own top comment for why that does not
generalize here).

**Singleton/persistent**: create, modify and remove are ALL delivered to
the rule's one query agent, exactly the BUTCHR-407 requirement. A resource
entering the query's scope is `{appeared: true}`; a resource leaving is
`{disappeared: true}`, delivered on EXACTLY the poll it leaves — the
following poll it is absent from both sides of the diff and is never
reported again (see `unionDiff`/`decideFromUnion` in
`src/rules/filesystem-type.ts`). This is a deliberately DIFFERENT diff from
`execution.ts`'s shared `diffMatches` (which only ever compares keys present
in the newer snapshot and so can never see a removal) — required here
because remove is a first-class requirement for filesystem specifically.

## Activation

A `filesystem` resource is always `"active"` while matched — there is no
sleep state (`src/rules/filesystem-type.ts`'s `activation.verdictFor`
always answers `"active"`, same as `github-issue`/`zendesk-ticket`).

## Safety

- **Read-only.** The provider's own I/O is `readdir`/`lstat`/`realpath`
  only — nothing ever opens a file for writing, renames, or deletes
  anything. An agent working the resource may of course edit it with its
  own tools; the PROVIDER itself never does.
- **Symlinks are never followed** — for traversal, or as a candidate
  resource in their own right, even one that stays inside `root`. This is
  what makes "refuse resources outside the declared root" true BY
  CONSTRUCTION: every path this module reports is built by joining
  already-real path segments read from `root` downward, so it can never
  point outside `root`'s own real tree. `root` itself IS resolved through
  `realpath` once (so a `root` that is itself a symlink still walks its
  real target) — only descendants stop there.
- **Two caps bound one poll's cost independent of match count**: `MAX_VISITED`
  (200,000 directory entries read) and `MAX_RESULTS` (5,000 matched
  resources). Either one crossed rejects the WHOLE query for that rule —
  never a silently truncated list, the same "a partial result must never
  read as a smaller true set" discipline `ZENDESK_SEARCH_LIMIT`/
  `GITHUB_SEARCH_LIMIT` already apply. Narrow the root, `namePattern` or
  `maxDepth` if a rule crosses either.
- **A resource whose id can't fit a workspace directory name is skipped, not
  crashed on** — a THIRD, per-resource limit (255 encoded bytes; see
  "Resource identity" above), unlike the two caps above: it drops just that
  one resource (logged), never the whole query.
- A missing or unreadable `root` fails the POLL for that rule (logged,
  nothing stopped/spawned that poll) — the same "any one rule's failed
  search rejects the whole poll" doctrine every provider's `search*Rules`
  already has. A subdirectory that vanishes or turns unreadable mid-walk
  (the tree changes concurrently) is skipped quietly instead — that branch
  just reports fewer matches, not a failed poll.
- No live daemon config edits or restarts (BUTCHR-368): everything above is
  verified in tests against temp directory trees, never the real running
  daemon or its real config.

## What an agent can do

There is **no general-purpose butchr MCP tool** for a filesystem resource —
its agent reads and edits it directly with its own file tools
(Read/Write/Edit/Bash), the same access every agent already has to its own
workspace. The ONE exception (BUTCHR-456): the built-in `managed-sessions`
rule (see `docs/managed-sessions.md`) is itself an ordinary `filesystem`
rule, and its own agents may be delegated `freeze_session`/`unfreeze_session`
via an explicit per-definition grant — never available to a `filesystem`
agent under any OTHER rule id. Jira, Confluence, GitHub and Zendesk MCP
tools all refuse a `filesystem` agent
(`src/tools/github-issue.ts`'s `forJiraCallers`, generalized to every
non-`jira-work` provider via `callerIdentity`). A `filesystem` agent
identifies to MCP with `x-butchr-agent` alone (`KEY_ONLY_PROVIDERS`,
`src/mcp/identity.ts`) — its resource is a path, not a Jira key, so no tool
can be misled into resolving it as one. Because it therefore has no single
Jira ticket, `get_doc`/`set_doc` and every relationship verb
(`report_to_boss`, `ask_boss`, …) refuse it too — the same, already-existing
limit every other key-only provider's query-level agent has (see
`docs/execution-modes.md`'s "What tools a query-level agent has").

## Query-based agents are free-form (non-goal, recorded on the epic)

Per BUTCHR-391's own epic-level decision: a `filesystem` rule's agents
(managed-session definitions, BUTCHR-408, included) do NOT get butchr's
upstream/downstream boss/worker relationship model. No `Implements` links,
no `report_to_boss`/`submit_to_boss` routing, no `childRule`/
`inwardConnectionRules` wiring tied to hierarchy — this is the same limit
"What an agent can do" above already describes for `get_doc`/`set_doc` and
the relationship verbs, restated here as the deliberate design decision it
is, not an oversight. Query-based agents are free-form; they act on
Jira/Confluence through the Atlassian MCP, and butchr's hierarchy verbs are
for jira-work ticket agents (Epic/Story/Task) only.

## Not in this version

- No `fs.watch`/inotify — polling only (deterministic, injectable, and the
  ticket's own requirement explicitly allows it).
- No relationships (`childRule`/`inwardConnectionRules`) — a `filesystem`
  rule takes none, and no other rule may reference one.
- No content reads through a butchr tool — an agent reads the file itself.
- No `**` glob, brace expansion, or character classes in `namePattern` — a
  literal basename match with `*`/`?` only.
- No account lifecycle (`account: "temporary"|"permanent"` is accepted and
  stored, like every other provider, but implements nothing — that is a
  later story, S4, for every provider alike).
- The well-known managed-session definitions directory and its manifest
  format (vendor/tier/channels/MCP/role) — out of scope for this ticket,
  filed separately as BUTCHR-408 after this merges. This provider is
  designed so a directory-of-manifests rule can be expressed as an ordinary
  `filesystem` rule without special-casing, but the manifest format itself
  is not built here.
- `BUTCHR-383` (the connection-kind/provider generalization epic) had not
  landed any code as of this ticket (still "To Do" — see BUTCHR-407's own
  ticket comment history) — this provider follows the CURRENT
  `ResourceType<T>`/rule-schema pattern (the same shape `zendesk-ticket`/
  `github-issue` use), not BUTCHR-383's shape. If/when BUTCHR-383 lands, it
  may subsume parts of this (the query-validation branch in
  `src/rules/rules.ts`, the key-only MCP identity wiring) — noted for
  whoever picks that up next, not resolved here.
