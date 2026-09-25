# Managed-session definitions

BUTCHR-408 (story BUTCHR-393 S2, epic BUTCHR-391). Butchr always runs ONE
built-in query — a `filesystem` rule (BUTCHR-407) it constructs itself,
never read from `rules.json`, never user-editable — over a well-known
directory of managed-session definition files: one JSON manifest per
Butchr-managed agent (a Bakr directory agent, a Candlestix session). This is
what lets Baker's directory-driven agents and Candlestix's managed sessions
"run as applications of Butchr's query -> agent model" (the story's own
goal) without either product's own supervisor.

## The well-known directory

`sessionDefinitionsPath()` (`src/resources/session-definition.ts`) resolves,
in order: `BUTCHR_SESSION_DEFINITIONS_DIR` (explicit override) else
`$XDG_CONFIG_HOME/butchr/session-definitions` else
`~/.config/butchr/session-definitions` — the SAME resolution shape
`rulesPath` already uses for `rules.json` (`src/rules/rules.ts`), so an
operator who knows one recognises the other immediately. Unlike `rulesPath`,
this names a DIRECTORY, not a file: one `*.json` manifest per managed agent,
direct children only (no recursion — a definition is never nested). A
missing directory is zero definitions, nothing staffed, no error, no
`/health` failure — same "absent means empty, not broken" discipline as a
missing default `rules.json` (`isMissingRootError`, `src/resources/filesystem.ts`,
distinguishes "does not exist" (`ENOENT`) from "exists but unreadable, or
is not a directory", which still fails the poll loudly — see
`searchSessionDefinitions`'s own doc comment, PR #394 review fix 3).

Root resolution happens once at daemon startup (a directory-var change
takes effect on restart, not live), like every other provider's query.

## Manifest format

```json
{
  "workingDirectory": "~/code/brooswit-factory/some-project",
  "brief": "Keep this repo's docs and dependency versions current.",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "default",
  "execution": "swarm",
  "account": "none",
  "role": "worker",
  "frozen": false,
  "mcpServers": [
    { "name": "mud-bridge", "type": "http", "url": "https://mud.internal/mcp", "headersEnvVar": "MUD_BRIDGE_HEADERS", "channel": true }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `workingDirectory` | yes | Where the managed agent actually works. Absolute, or `~`/`~/rest` (expanded against the daemon's own `$HOME`, same rule as a `filesystem` query's `root`). The agent is told to `cd` there at startup — see "Working directory wiring" below for why this is not the launched process's own OS `cwd`. |
| `brief` | yes | The agent's prompt/role. Literal text; no `@builtin:` shorthand (that convenience is a `Rule` field's, not a definition's). |
| `vendor` | yes | `"claude"` or `"codex"` — narrower than `Rule.agentPreferences[].harness` (`agy` is not a Bakr/Candlestix vendor). |
| `tier` | yes | `"tier1"` \| `"tier2"` \| `"tier3"` \| `"tier4"` \| `"tier5"`, mapped to a concrete model by `tierToModel(vendor, tier)` — see "Tier -> model mapping" below. |
| `permissionMode` | yes | `"default"` \| `"acceptEdits"` \| `"bypassPermissions"` \| `"plan"` \| `"auto"`. Reaches a Claude launch's `permissionMode` verbatim (see "Per-vendor launch differences"). |
| `execution` | no | Reuses `Rule`'s `ExecutionMode` type/validation VERBATIM (`"swarm"` default). Stored, surfaced — NOT acted on by this ticket; see "Not in this version". |
| `account` | no | Reuses `Rule`'s `AccountPolicy` type/validation verbatim (`"none"` default). Stored only — the Rocket.Chat account lifecycle itself is unimplemented for every provider today, managed sessions included. |
| `role` | no | Reuses `Rule`'s `AgentRole` type/validation verbatim (`"worker"` default, `"sentinel"` for fleet-cap-exempt agents — e.g. Candlestix directors, MUD players). Read by the fleet-cap admission classifier — see "role -> fleet-capacity admission" below. |
| `frozen` | no | `false` default. A frozen definition is a VALID one that simply runs no agent — see "Eligible = valid, not frozen" below. |
| `mcpServers` | no | Additional MCP servers this agent may connect to, beyond butchr's own — see "`mcpServers`: additional MCP server bindings" below. |

A bad manifest (invalid JSON, an unknown field, a wrong-type/out-of-range
value) is rejected with every problem named, collected in one pass, same
style as `filesystem`'s own query validation:

```
/home/butchr/.config/butchr/session-definitions/foo.json: rules[0].vendor must be one of claude, codex
```

### `mcpServers`: additional MCP server bindings

The ticket's own required field — "MCP server list, with per-MCP
notification flags; channel bindings to ANY MCP channel server" — reuses
`McpServerBinding`/`parseMcpServers` (`src/rules/rules.ts`) **verbatim**,
never a competing shape. That type was ported there from S4's
(BUTCHR-395/BUTCHR-411) `BUTCHR-395` branch (PR #387, merge commit
`5520722`) as source material, per the epic's sequencing decision on
BUTCHR-408 (2026-09-25: "don't wait for S4 — import the type + validator,
finish the MCP/channel section with the real type"). When S4's own
`Rule.mcpServers` lands on `main`, it should reuse this exact type/module
rather than reintroducing it — the type lives in `rules.ts`, not
`session-definition.ts`, specifically so both can share it without either
owning the other's shape.

```json
"mcpServers": [
  { "name": "mud-bridge", "type": "http", "url": "https://mud.internal/mcp", "channel": true },
  { "name": "quiet-tools", "type": "http", "url": "https://internal/tools", "headersEnvVar": "QUIET_TOOLS_HEADERS", "channel": false }
]
```

| binding field | required | meaning |
|---|---|---|
| `name` | yes | Letters/digits/`_`/`-`; unique within the list; `"butchr"` is reserved. |
| `type` | yes | Only `"http"` today. |
| `url` | yes | Absolute `http`/`https` URL. |
| `headersEnvVar` | no | The NAME of an env var on **this daemon's own process** holding a JSON object of header values — never a literal header value in the definition file itself. Resolved fresh at launch time (`resolveMcpServerHeaders`, `src/agents/workspace.ts`); missing/malformed resolves to "no extra headers" (logged once, value never logged). |
| `channel` | yes | `true` adds `--dangerously-load-development-channels=server:<name>` for a **Claude** launch, alongside `server:butchr` — the same mechanism that already delivers butchr's own push notifications, so a non-Rocket.Chat MCP server (e.g. a MUD bridge) gets event-driven delivery with no polling substitute. `false` still reaches `mcp.json`/Codex's tool list (tools work) but is never added to the channel flag. |

**Per-vendor reach, and the ONE case this manifest must never build (S4/PR
#387's own hardened review finding, ported here verbatim):** a bound
server's `headersEnvVar` value is resolved and written **ONLY** into a
Claude workspace's `mcp.json` (chmod `0600` whenever it carries a resolved
header — `buildWorkspace`). A **Codex** agent gets a bound server's TOOLS
with **NO headers at all**, regardless of `headersEnvVar` — Codex's launch
argv is a real process command line any other local user can read via
`ps`/`/proc`, and Drovr renders a Codex header as literal argv text.
**This is why BUTCHR-408's own Codex staged example (scenario (c)) never
depends on an authenticated bound server** — an authenticated bridge is
simply not usable from a Codex managed-session agent yet. The per-MCP
"notification flag" the ticket's own text names is `channel`, exactly as
S4 designed it; nothing else was added on top.

Channel **delivery** to a non-Claude vendor (Codex push notifications) is
still out of scope — see "Not in this version".

## Tier -> model mapping

PORTED from Candlestix's own `~/.config/candlestix/model-tiers.json` on
host Codey. The ticket's preserved-branch pointer
(`preserve/candlestix-runtime-f198ae1/`, "the CNDLX manager workspace") and
its fallback (`~/code/brooswit-factory/candlestix`) were both searched
exhaustively (2026-09-25, BUTCHR-408) and neither is reachable from this
build host — this was raised as an `ask_boss` on BUTCHR-408 rather than
guessed. The answer (BUTCHR-408 comment 23948, 2026-09-25, story agent)
relays CNDLX-45 comment 23525 (John Winstead, "Codey inventory v1",
2026-09-24T22:00Z), which this doc's author read and cross-checked
verbatim before porting the table below.

CAVEAT, carried forward from that same relay: this is a REPORT of a file
none of us can read directly (Codey host access is blocked — CNDLX-45 says
so), so it is ported as DATA (`CLAUDE_TIER_MODEL`/`CODEX_TIER_MODEL` in
`src/resources/session-definition.ts`), not logic, and is **unverified
against the live file**. A future mismatch against the real Codey file is
grounds to fix this table, not to distrust the reporter.

| tier | claude model | codex model |
|---|---|---|
| `tier1` | `sonnet` | `gpt-5.6-luna` |
| `tier2` | `sonnet` | `gpt-5.6-terra` |
| `tier3` | `sonnet` | `gpt-5.6-sol` |
| `tier4` | `opus` | `gpt-6-astra` |
| `tier5` | `opus` | `gpt-6-astra` |

`tierToModel(vendor, tier)` is the ONE place this mapping lives; update it
(and `SESSION_TIERS` if the tier names themselves turn out different) if a
verified read of the live file ever disagrees — nothing else in this
codebase encodes tier names.

## role -> fleet-capacity admission

A definition's own `role` actually exempts its agent from the fleet
capacity cap — a `role: "sentinel"` manifest (every Bakr/Candlestix
definition in the S5 mapping) is not withheld by, and does not count
toward, the admission limit, same as a rule-level `role: "sentinel"`
already did before this ticket.

Butchr's existing fleet-cap classifier, `roleOfAgent` (`src/daemon/index.ts`,
BUTCHR-398), resolves a role from a `Rule` — but the built-in
managed-sessions rule is ONE shared `Rule` for every heterogeneous
definition file, so a per-file role needs a different hook than a
per-rule lookup. That hook is `managedSessionRoles`, a
`Map<agentKey, AgentRole>` the managed-sessions loop rebuilds every poll
from that poll's eligible (valid, not frozen) matches — cleared and
refilled, never merged, so a definition that goes ineligible (removed,
edited invalid, frozen) stops being sentinel-exempt the SAME poll it drops
out. `roleOfAgent` consults this map first for any managed-session agent
id, before falling back to its ordinary rule-level lookup (which — for the
built-in rule specifically — is always `"worker"`, since that rule's own
`role` never reflects a per-file value; see
`builtinManagedSessionsRule`'s own doc comment).

**Before this loop's first poll after a daemon restart** (e.g. an
already-running sentinel agent whose definition has not been read again
yet), the map has no entry, and `roleOfAgent` falls back to `"worker"` —
the SAME fail-safe default it already documents for any id it cannot
resolve. This is a brief, one-poll-cycle window (`MANAGED_SESSIONS_POLL_MS`
= 15s, and the loop's own fetch runs immediately on start, not only after
the first interval), not a persistent gap.

## Eligible = valid, not frozen

The built-in query's own definition of "eligible" (the ticket's own words),
decided once, in `searchSessionDefinitions` (`src/rules/session-definition-type.ts`):

1. List every direct child file of the definitions directory (an ordinary
   `filesystem` query, `{root, kind: "file", maxDepth: 1}`).
2. **A hidden file (its basename starts with `.`) is never a candidate at
   all — skipped SILENTLY, before any other check, never logged**
   (`isHiddenDefinitionFile`, `src/resources/session-definition.ts`;
   BUTCHR-455 review fix). The query above has no name filter, so without
   this a definition writer's own temp file (`writeFileAtomic`'s
   `.<uuid>.tmp` — used by `create`, `freeze`/`unfreeze`'s manifest
   rewrite, and `unarchive`'s cross-filesystem fallback) would be a
   candidate for the brief window it sits in the active directory: if a
   poll landed there and the temp content happened to already be a valid,
   non-frozen manifest (true for every one of those writers, which each
   write/rewrite a full valid document), it would be staffed as a SECOND
   agent under a key with no relationship to the real definition's own
   freeze state. `listSessionDefinitions` (`butchr session list`) applies
   the identical filter, for the identical reason — a hidden file is never
   shown, valid or not, same as it's never staffed.
3. A path whose percent-encoded id would overflow the workspace
   directory-name limit is skipped and logged once — the SAME 255-byte
   check and discipline `filesystem` already applies to every resource
   (`docs/filesystem.md`'s own "Resource identity" section).
4. A file that fails to parse or validate is skipped and logged once
   (`WARNING: [managed-sessions] <path> is not a valid definition, never
   staffed: <problems>`) — never staffed, never silently dropped, never
   crashes the poll; a sibling definition's own validity is unaffected.
5. A file that parses and validates but is `frozen: true` is skipped and
   logged once, DISTINCTLY from an invalid one (`[managed-sessions] <path>
   is frozen — no agent runs`) — frozen is a property of a valid
   definition, not a kind of invalidity.
6. Everything left is eligible: one `filesystem`-provider agent per
   definition file, under `swarm` execution (the built-in rule's own FIXED
   mode) — which is already "keeps exactly one agent per eligible
   definition" at the file granularity this ticket covers, no
   singleton/persistent grouping needed at the rule level.

Reconciliation itself (spawn the missing, stop the gone, never double-spawn
an already-running key) is the existing, already-tested `planReconcile`
(`src/daemon/loop.ts`) — an agent's identity is its filesystem agent key
(`filesystem:managed-sessions:<percent-encoded-path>`), so re-polling never
double-staffs an already-running definition; this ticket adds no separate
adoption mechanism (see `test/unit/session-definition-type.test.ts`'s
"no-double-owner" case).

Editing an already-running definition's content (its brief, tier, ...) does
NOT force a respawn — the agent key is unchanged, so `planReconcile` still
reads it as "already running, leave alone" — same precedent as editing a
`rules.json` rule's own `brief` never respawning its already-running
per-resource agents. A content change instead notifies the running agent
(size/mtime moved — `createSessionDefinitionEventRules`), same "modify"
precedent `filesystem` already has for its own swarm agents.

## The `butchr session` CLI (BUTCHR-454, BUTCHR-455)

There is now an operator CLI for the whole lifecycle: `butchr session
list|show|create|freeze|unfreeze|archive|unarchive`, credential-free and
daemon-free, exactly like `butchr link`'s own precedent
(`src/cli/link-cli.ts`) — dispatched from a guard at the very top of
`src/daemon/index.ts`, before config/rules loading. A managed-session
definition is local filesystem state (plus the `drovr-events` freeze store
below, and — for archive/unarchive — a second, sibling directory), so none
of these verbs need a live daemon, Jira credentials, or a rules file.

```
usage: butchr session list [--archived]
       butchr session show <name>
       butchr session create <name> --working-directory <dir> --brief <text>
                             --vendor claude|codex --tier tier1..tier5
                             --permission-mode default|acceptEdits|bypassPermissions|plan|auto
                             [--execution swarm|singleton|persistent]
                             [--account none|temporary|permanent]
                             [--role worker|sentinel] [--frozen]
                             [--mcp-servers <json array>]
       butchr session freeze <name>
       butchr session unfreeze <name>
       butchr session archive <name>
       butchr session unarchive <name>
```

`<name>` is a definition file's basename, with or without `.json`, resolved
against the same well-known directory `sessionDefinitionsPath()` resolves
(`BUTCHR_SESSION_DEFINITIONS_DIR`, else `$XDG_CONFIG_HOME/butchr/session-
definitions`) — or, for `unarchive` and `list --archived`, against the
archive directory instead (see "Archive/unarchive" below).

- **`list`** enumerates every direct-child file of the active directory —
  the SAME candidate set `searchSessionDefinitions` walks (same query, same
  255-byte encoded-path cap) — but, unlike the daemon's own poll, an
  invalid or oversized definition is listed too, WITH its problems, never
  dropped: "eligible" is the daemon's own filter, not this command's. Each
  row also names both freeze gates (see "Two freeze gates" below). Plain
  `list` **never** shows an archived definition — pass `--archived` for
  that (see "Archive/unarchive" below).
- **`show <name>`** is one `list` row's full detail: parsed
  vendor/tier/role/execution (when valid; every collected problem
  otherwise), the resolved filesystem agent key, and both freeze gates.
- **`create <name> ...`** validates through `sessionDefinitionProblems` —
  the EXACT function `parseSessionDefinitionFile` (and so the daemon's own
  poll) runs a manifest through, never a forked copy of the schema — then
  writes the fields AS GIVEN (a `~`-prefixed `workingDirectory` is written
  back as `~...`, never daemon-expanded; an omitted optional field stays
  omitted, never defaulted onto disk) via a temp-file-then-`rename` in the
  SAME directory (`src/resources/atomic-write.ts`), so the daemon's ~15s
  poll (`MANAGED_SESSIONS_POLL_MS`) never observes a half-written file.
  Refuses outright if a definition of that name already exists **in either
  the active directory or the archive directory** (BUTCHR-455 closes the
  gap BUTCHR-454 flagged: creating a name that collided with an archived
  definition used to succeed, and a later `unarchive` of that name would
  then collide with the new active file it never knew about).
- **`freeze <name>` / `unfreeze <name>`** flip both freeze gates (below),
  in the decided order, and print a note that the effect reaches a running
  daemon within one poll (`MANAGED_SESSIONS_POLL_MS` = 15s) — or, if no
  daemon is currently running, the next time one starts — plus the
  resolved definitions directory and freeze-store root (BUTCHR-454 review
  follow-up), so an operator can spot the shell/daemon environment
  mismatch described below. **The CLI never stops an agent itself** —
  only the running daemon's own reconcile (`reconcileNow`) plus
  `watchInstanceFreeze` do that; this command only changes state for the
  daemon to observe.
- **`archive <name>` / `unarchive <name>`** — see "Archive/unarchive"
  below.

### Two freeze gates, and why both

Butchr already had a freeze mechanism before this ticket:
`HerdrHerd.frozen()` (`src/agents/herd.ts`) reads `@brooswit/drovr-events`'
`instanceFreezeStore`, keyed `` `butchr:<agentKey>` ``; `reconcileNow`
(`src/daemon/loop.ts`) drops a frozen id from `desired` before BOTH its
spawn and its stop decision, unconditionally — an explicit freeze wins
over `execution: "persistent"`/`role: "sentinel"` with no special case
needed there (proven at the reconcile level, not just by asserting the
store's own value, in `test/unit/session-freeze.test.ts`). This is the
SAME store the daemon already reads; `butchr session freeze`/`unfreeze`
is the first thing in this codebase that ever WRITES it (previously only
`drovr-events`' own `drovr-instance` CLI did).

A definition also has its own manifest `frozen` field (S2/BUTCHR-393),
already read by `searchSessionDefinitions` to exclude it from the eligible
set entirely (see "Eligible = valid, not frozen" above). `butchr session
freeze`/`unfreeze` sets/clears BOTH gates together:

- **freeze**: (1) `instanceFreezeStore.set("butchr:<agentKey>", true)`
  FIRST, then (2) rewrite the manifest's `frozen: true` (preserving every
  other field's value, via the same atomic write `create` uses).
- **unfreeze**: (1) rewrite the manifest's `frozen: false` FIRST, then
  (2) `instanceFreezeStore.set(..., false)`.

Both are idempotent regardless of the starting combination (only one gate
set, both set, or neither) — they always end with both gates in the
target state.

**Why both, when either alone stops a running agent:** the store's key is
derived from the definition's FILE PATH (`sessionAgentKey`,
`src/resources/session-freeze.ts` — the exact codec
`searchSessionDefinitions` uses to build a match's own `agentKey`).
Renaming or moving a manifest changes that key, silently dropping any
store-only freeze state. The manifest flag survives a move, because
`searchSessionDefinitions` reads it from whatever file is AT the (possibly
new) path — independent of any store key. This is what lets a frozen
persistent definition (the 10 CNDLX-45 MUD players) stay frozen through an
archive/restore move (BUTCHR-455, below), even though that changes the
store key entirely. **The caveat this implies, closed by BUTCHR-455:**
archive/unarchive restores a manifest's EXACT original filename (never a
caller-supplied destination name) — see "Archive/unarchive" below for how
that's enforced (refuse-on-collision, not rename-on-collision) and why it
matters even for a definition that was only ever store-frozen (manifest
field left `false`).

`freezeSessionDefinition`/`unfreezeSessionDefinition`
(`src/resources/session-freeze.ts`) are plain, argv/stdout-free core
functions for exactly this reason — a later task's `freeze_session`/
`unfreeze_session` MCP tools (for delegated freeze control, e.g.
`director-brooswit-mud`) call them directly, unchanged; `butchr session
freeze`/`unfreeze` is a thin CLI layer over the same two functions, not a
second implementation.

## Archive/unarchive (BUTCHR-455)

`butchr session archive <name>` moves a definition file OUT of the active
definitions directory into a second, sibling ARCHIVE directory — a
location the built-in query's own `{root: <active dir>, kind: "file",
maxDepth: 1}` listing can never see (see "Eligible = valid, not frozen"
above: eligibility is decided purely by what's a direct child of the active
directory). `butchr session unarchive <name>` moves it back. Neither verb
stops or starts the agent itself — same design as freeze/unfreeze: the CLI
only changes what's on disk, and the running daemon's own next reconcile
poll (up to `MANAGED_SESSIONS_POLL_MS` = 15s later, or the next time a
daemon starts) is what actually stops (archive) or spawns (unarchive) it,
because the file leaving/rejoining the active directory's listing is all
`searchSessionDefinitions` (and so `desiredFrom`/`reconcileNow`) ever look
at. Both verbs print the resolved active directory, archive directory and
freeze-store root, for the same reason `freeze`/`unfreeze` do (see the
environment-mismatch section below).

### The archive directory

`sessionArchiveDir()` (`src/resources/session-archive.ts`) is the ONE
function every caller resolves this through: `BUTCHR_SESSION_ARCHIVE_DIR`
(explicit override) else a sibling of the (resolved) active definitions
directory, named after it with an `-archive` suffix — e.g. an active
directory of `.../butchr/session-definitions` resolves a default archive
directory of `.../butchr/session-definitions-archive`. `sessionArchiveDir`
never validates its own result; `assertArchiveDirDisjoint(definitionsDir,
archiveDir)` (same module) does, and every command that touches the
archive directory (`archive`, `unarchive`, `list --archived`, and
`create`'s collision check) calls it FIRST, before anything else happens:
it throws if the resolved archive directory would equal or sit inside the
active definitions directory — which would mean an "archived" file is
still (or becomes, one level down) a candidate the active query can see,
defeating the entire point of archiving it. This is a refusal at command
startup, not a moved-then-regretted state: nothing is touched before this
check runs.

### The identity rule, and why it's load-bearing

An agent's identity — its filesystem agent key, and so the freeze-store
key `butchr:<agentKey>` (see "Two freeze gates" above) — is derived from a
definition's FILE PATH. `archive`/`unarchive` therefore move the file under
the EXACT SAME BASENAME, never a caller-supplied destination name, and
never touch the file's own byte content. Restoring a definition to the
exact path it was archived from is what makes `unarchive` bring back the
SAME agent — same key, same store-freeze answer — rather than a new,
unrelated one that happens to share a brief. This is also why both verbs
REFUSE outright (nothing moved) rather than picking a different name on
collision: a silent rename would either orphan the original's identity (if
the caller expected the same name back) or silently create a same-named
collision waiting to happen on a future `unarchive`.

Refused, nothing moved, in either direction:
- `<name>` is not a plain basename — empty, `.`/`..`, or containing a path
  separator (`definitionBasenameProblem`, `src/resources/session-archive.ts`;
  BUTCHR-455 review fix). Checked FIRST, before either verb even builds a
  source/destination path: unlike `show`/`freeze`/`unfreeze`, which all
  resolve a name by first LISTING the directory and matching an entry
  (inherently safe, since the result is always a path the listing itself
  already reported), `archive`/`unarchive` build `join(dir, name)`
  directly — an unchecked `../../etc/passwd` (or an absolute path) would
  let either verb move a file from, or over, somewhere entirely outside
  either directory.
- the source file does not exist;
- a file of that name already exists at the destination (the archive
  directory for `archive`, the active directory for `unarchive`);
- the destination directory cannot be created.

The manifest's own `frozen` field travels with the file's content
unconditionally — archive/unarchive never reads or rewrites it — so a
frozen definition (both gates, or the manifest gate alone) reads exactly
as frozen at its new path as it did at the old one; an unfrozen one stays
unfrozen. The freeze-store gate is untouched too: reading it via the
would-be-active path after an `unarchive` reads the SAME key it was ever
written under, because the path is identical (see `test/unit/session-
archive.test.ts`'s "frozen state survives archive then unarchive" suite,
including the store-only-frozen case this identity rule specifically
protects).

### Move mechanics: atomic where the platform allows, safe fallback otherwise

The move is a plain same-filesystem `rename` when the active and archive
directories share one (the ordinary case: the default archive directory is
a sibling of the active one, and `BUTCHR_SESSION_ARCHIVE_DIR` is expected
to usually stay on the same volume) — atomic, so the daemon's ~15s poll of
the active directory never observes a half-written or partially-moved
file. When `rename` itself fails with `EXDEV` (the two directories are on
different filesystems — only possible via the env override), the fallback
is: copy the file to a temp name IN THE DESTINATION directory, `rename`
that temp file into place (same filesystem as the destination, so this
step is still atomic), then unlink the source — never the other order, and
the source is only ever unlinked after the destination rename has already
succeeded. A failure at any step before that final rename leaves the
source untouched and best-effort cleans up its own temp file; no partial
file is ever left under the destination's own final name.

### Post-archive hook seam (not yet wired to S4)

`archiveSessionDefinition` accepts an injected `onArchived({ agentKey,
path })` async hook, default no-op, run once after a successful move.
This exists for S4 (BUTCHR-395), which owns Rocket.Chat account cleanup
(`releaseAccount(agentKey, "archive")`, `src/accounts/manager.ts`) — but
that code lives on the BUTCHR-395 story branch, not `main`, so **this
ticket wires the seam and imports nothing from that branch**; a follow-up
task wires the real hook in once BUTCHR-395 merges. A hook failure is
reported loudly (the CLI prints it to stderr, and the core function
surfaces it as `ArchiveResult.hookError`) but **never undoes the move** —
by the time the hook runs, the definition is already out of the eligible
set, and rolling the file back on a hook failure would silently re-enter
it into the eligible set for a reason (account cleanup) unrelated to
whether the move itself was valid. The hook is never called on a refusal,
and `unarchive` has no hook parameter at all (this seam is one-directional:
S4's cleanup is an archive-time concern).

### `list --archived`

`butchr session list --archived` lists every direct-child file of the
ARCHIVE directory, same columns and same "invalid entries shown, not
hidden" discipline as plain `list`. Plain `list` never shows an archived
definition (it only ever queries the active directory). **One deliberate
asymmetry:** an archived entry's freeze gates are computed against the
path it would have once RESTORED to the active directory, NOT its current
archive-directory path — because the store gate is path-derived (see "The
identity rule" above), reading it at the file's current (archived)
location would always answer `false`, regardless of what it actually is or
will be once unarchived. `listSessionDefinitions`'s `identityDir` parameter
(`src/resources/session-definition-manage.ts`) is what makes this
possible: it lists/reads from one directory but computes `agentKey`/
`storeFrozen` against another. The manifest gate is unaffected by this —
it always reads the file's own actual (archived) content, which is exactly
where the `frozen` field itself is stored.

### `create`'s archived-name collision check (BUTCHR-454 gap closed)

`create <name> ...` now refuses if a definition of that name exists in
EITHER the active directory or the archive directory. Before this ticket,
only the active directory was checked (see the note this section replaces
in earlier revisions of this doc) — creating a name that collided with an
archived definition would succeed, and a later `unarchive` of that name
would then collide with the newly-created active file, which the create
step never knew existed.

## Shell/daemon environment mismatch (BUTCHR-454 review follow-up)

The CLI resolves the active definitions directory, the archive directory
and the freeze-store root (`DROVR_CONTROL_HOME`, honoured via
`freezeStateRoot()`) from the **INVOKING SHELL's** environment — not the
daemon's. The daemon runs under a systemd user unit (`butchr.service`),
whose environment is whatever was set at the unit's own start, which can
silently differ from an operator's interactive shell (a different
`XDG_CONFIG_HOME`, a leftover `BUTCHR_SESSION_DEFINITIONS_DIR` from a
previous debugging session, ...). This is why every archive/unarchive/
freeze/unfreeze command prints its resolved directories/root — so a
mismatch is visible immediately, rather than showing up later as "I ran
`butchr session freeze foo` and nothing happened."

What each kind of mismatch actually does:
- **Definitions-directory mismatch:** the CLI operates on a directory the
  daemon never polls (or a different one than the operator expects) —
  fails LOUDLY and immediately, the same `no definition named "<name>" in
  <dir>` a plain typo would produce, because the CLI can't find the
  definition it was asked to act on in the directory it resolved. Nothing
  silently no-ops.
- **Freeze-store-root-only mismatch** (the definitions directory matches,
  but `DROVR_CONTROL_HOME` doesn't): the manifest gate still gets set/read
  correctly (it's a field in the definition file itself, wherever that
  file lives) — a `freeze`/`archive` invoked this way still visibly takes
  effect via the manifest flag. But the STORE gate is silently written to
  a DIFFERENT root than the one the daemon's own `HerdrHerd.frozen()`
  reads — an operator who only checked "the manifest says frozen: true"
  could reasonably but wrongly conclude the store gate agrees; it does
  not, and the daemon-side answer for that gate is whatever a previous
  write to the DAEMON's own root last left it at. This is the one mismatch
  that does NOT fail loudly, which is exactly why the resolved
  freeze-store root is printed on every freeze/unfreeze/archive/unarchive
  — compare it against `journalctl --user -u butchr.service`'s own startup
  log (or the daemon's environment directly) when a freeze/archive doesn't
  seem to be taking effect.
- **Archive-directory mismatch:** same shape as the definitions-directory
  case — `unarchive`/`list --archived` operate against a directory that
  may not be where a previous `archive` (run under a different
  environment) actually put the file; a `does not exist` refusal is the
  visible symptom, not a silent no-op.

## Working directory wiring

`SpawnSpec.cwd` (`src/agents/workspace.ts`, BUTCHR-408) carries a
definition's own `workingDirectory` through the shared spawn machinery —
but, as of PR #394's THIRD review round, it is **not** the spawned
process's own OS-level `cwd`. That was round 2's design, and it broke the
real spawn path (see "Why not a real process cwd" below); the definition's
working directory is instead communicated to the agent through its own
KICKOFF instructions.

**The spawned process always launches at the ordinary bookkeeping
directory** (`workspaceDirFor(spec.key)` — the SAME synthetic
`<workspace root>/filesystem/managed-sessions/<encoded-path>` directory
every other filesystem resource gets), exactly like every other provider,
whether or not `spec.cwd` is set (`agentLaunchConfig`, `src/agents/argv.ts`).
`buildWorkspace` likewise always writes CLAUDE.md/AGENTS.md/brief.md/
mcp.json/ENVIRONMENT.md there, never into `spec.cwd` — the operator's own
project directory may already hold its own `CLAUDE.md`/`AGENTS.md`, and
writing butchr's own bookkeeping files there would silently destroy them
(caught live in round 1 of PR #394's review).

**The agent learns its real working directory from its own kickoff
prompt.** `kickoffFor` (`src/agents/argv.ts`), when `spec.cwd` is set,
returns `` `Your working directory for this task is <cwd> — cd there
before doing anything else. Then: <brief>` `` instead of the ordinary
`"follow your CLAUDE.md"`/`"follow your AGENTS.md"` string — the agent's
FIRST action is to `cd` into its real project directory itself, using its
own tools, before doing any of the definition's actual work. This also
fixes a round-2 defect: with the process launched directly at `spec.cwd`,
`"follow your CLAUDE.md"` there would have resolved to the *project's own*
`CLAUDE.md` (if any), never butchr's generated one, so the definition's
`brief` would never have reached the agent at all.

### Why not a real process cwd (round 2 -> round 3)

Round 2 made `agentLaunchConfig`'s own `cwd` field `spec.cwd` directly.
Reproduced live, through the REAL `HerdrHerd` + `@brooswit/drovr`
`ManagedHerdrLifecycle` (not a stub — `test/unit/herd.test.ts`), this broke
spawning ENTIRELY for any `cwd`-bearing spec, for two independent reasons
neither round 1 nor round 2's own tests exercised (both tested
`buildWorkspace`/`agentLaunchConfig` directly, never a real `herd.spawn()`):

1. **Drovr's own invariant.** `ManagedHerdrLifecycle` (constructed once per
   issue by `herd.ts`'s `lifecycle()`) is built with ONE fixed `cwd` —
   always `workspaceDirFor(issue)` — and hard-requires the prepared
   launch's own `cwd` to equal it exactly, throwing `"Launch does not
   match selected provider and workspace"` otherwise. It also uses that
   SAME `cwd` to create the herdr workspace/pane and as the residency key
   it filters `herdr.agent.list()` against. There is no seam in Drovr's
   current API for "the pane's OS cwd differs from its own workspace
   identity."
2. **`HerdrHerd.runningIssues()` cannot see a diverged pane at all.**
   `runningIssues()`/`byIssue()` reverse-map a live pane's cwd back to an
   agent id via `agentIdOfWorkspacePath`, which assumes the fixed
   `workspaceDirFor` 1-or-3-deep layout; a pane at an arbitrary operator
   directory returns `null` there. `runningIssues()` is what
   `scopedHerd`/admission residency/every rule loop's own reconciliation
   is built on — a managed-session agent whose pane cwd diverged would be
   PERMANENTLY invisible to it, breaking "never run two owners for the
   same managed agent" (this ticket's own explicit requirement), not just
   a cosmetic gap.

Both are core, heavily-shared daemon machinery every other provider also
depends on — not something to patch around under review pressure. The
chosen fix (communicate `cwd` through the kickoff prompt instead of the
process's own OS cwd) keeps EVERY existing invariant intact for managed
sessions exactly as it already is for every other provider, at the cost of
the agent needing one extra `cd` step of its own at startup.

**Absent** `spec.cwd` (every existing caller, and every provider besides
managed sessions), behaviour is byte-for-byte unchanged throughout.

## Nexus's MCP isolation constraint: every agent gets its OWN MCP config

Non-negotiable constraint from Nexus (relayed on this story 2026-09-25T14:00Z):
every managed-session agent gets its **own** MCP config; none may inherit a
parent directory's `.mcp.json`. Two independent directions, only one of
which is an actual GUARANTEE — round 2 of this constraint's own review
(PR #394) found the first direction alone was not enough, and asked for the
gap to be closed with an enforced check rather than an assumption about a
third party's behaviour:

**Direction 1 (asserted, tested, but NOT by itself a guarantee): the
operator's own `workingDirectory` is never touched.** `spec.cwd`
(`workingDirectory`) is never the spawned process's own OS `cwd` — see "Why
not a real process cwd" above — and `buildWorkspace` never reads, writes, or
otherwise touches a `.mcp.json` there. `test/unit/workspace.test.ts`'s
"Nexus MCP isolation constraint, direction 1" test proves exactly that: a
pre-existing `.mcp.json` in `workingDirectory` stays byte-identical. This
does NOT by itself prove Claude Code cannot discover it some other way —
see direction 2.

**Direction 2 (the actual guarantee): no `.mcp.json` in ANY ancestor of the
launched cwd.** Claude's own `--mcp-config` flag is ADDITIVE to its ordinary
project-level `.mcp.json` auto-discovery, never exclusive of it — this
codebase (and `@brooswit/drovr`, its launch layer) never passes
`--strict-mcp-config` anywhere, verified by grepping drovr's own built argv
builder. Claude Code's own discovery is understood to walk UP from the
launched process's OS `cwd` through ancestor directories (an assumption
about a third party's undocumented behaviour, not verified against its
source here) — and since that OS `cwd` is *always*
`workspaceDirFor(spec.key)` for a managed-session agent (never
`workingDirectory`), a `.mcp.json` sitting in `workspaceRoot()` or any of
ITS OWN ancestors could in principle be inherited. Rather than rely on that
assumption, `assertNoInheritedMcpConfig` (`src/agents/workspace.ts`) makes
it a non-issue regardless: `buildWorkspace`, for any managed-session spec
(`spec.cwd` set), walks every ancestor of `workspaceDirFor(spec.key)` up to
the filesystem root and **refuses the spawn outright** (throws before
writing anything) if any of them contains a `.mcp.json` — cheap (a handful
of `existsSync` calls, once per spawn attempt) and unconditional, so the
isolation property holds whether or not the assumption above is exactly
right. `test/unit/workspace.test.ts`'s "PR #394 review round 2, direction 2"
test proves the refusal fires, names the offending path, and writes nothing
first. A bare (non-managed-session) spec is never guarded — its
`workspaceDirFor` ancestor chain is the same shared tree, but this
constraint was raised specifically against the definitions-directory design.

Butchr's own per-agent `mcp.json` (no dot) is what the agent's
`--mcp-config` flag names explicitly, and contains ONLY butchr's own server
plus this definition's own `mcpServers` bindings, never anything from
`workingDirectory` or any ancestor.

Credentials reach that per-agent `mcp.json` only via `headersEnvVar` (a NAME,
resolved from the DAEMON's own environment — never a literal value in the
definition file), and `mcp.json` itself lives under `BUTCHR_WORKSPACES`
(default `~/butchr-workspaces` — `workspaceRoot()`, `src/agents/workspace.ts`),
a directory outside this git repo entirely, never tracked or committed — a
definition file under `sessionDefinitionsPath()` likewise never carries a
credential value, only `headersEnvVar` names.

## Per-vendor launch differences

`permissionMode` reaches a **Claude** launch's `ClaudeAgentLaunch.permissionMode`
verbatim (Drovr; untyped string there, validated at OUR layer via
`SESSION_PERMISSION_MODES` before it ever reaches launch, so a typo fails at
manifest-load time, not at spawn time) — **including `"bypassPermissions"`**,
which is honoured exactly as written, with no additional gate: a definition
file is operator-authored config (the same trust level as `rules.json`
itself), so a `bypassPermissions` manifest is presumed deliberate, same as
every other field here. **Codex** has no `permissionMode`
concept in `CodexAgentLaunch` (its own `trustWorkspace`/
`bypassApprovalsAndSandbox` fields instead) — a `vendor: "codex"`
definition's `permissionMode` is validated and stored like any other, but
is simply not forwarded to a Codex launch. Building Codex-specific
permission wiring is out of scope for this ticket.

## Not in this version

- **S4's own channel DELIVERY to a non-Claude vendor** (Codex push
  notifications) — the `mcpServers`/`channel` FIELD and its Claude-side
  wiring are real (see "`mcpServers`: additional MCP server bindings"
  above); a Codex agent still only ever gets a bound server's tools, never
  push, matching S4's own "Codex steering is a later story" scoping.
- **The Rocket.Chat account lifecycle** (`account: "temporary"|"permanent"`)
  — accepted and stored, like every `Rule`'s own `account` field, but
  implements nothing; the account lifecycle itself is a later story for
  every provider alike. `archiveSessionDefinition`'s `onArchived` hook
  (BUTCHR-455, see "Post-archive hook seam" above) is the wiring POINT for
  this — S4's `releaseAccount(agentKey, "archive")` — but is not itself
  wired to it yet: that hook still defaults to a no-op until a follow-up
  task connects it, once BUTCHR-395 (S4) reaches `main`.
- **A definition's own `execution` mode is not acted on.** The built-in
  rule always runs `swarm` (one agent per eligible definition file); a
  definition's `execution` field reuses `Rule`'s type/validation and is
  stored, but does not change how the built-in query groups its own
  matches (see "Eligible = valid, not frozen" above for why file-granularity
  swarm already satisfies the DoD's "one agent per eligible definition").
- **The S5 migration** (converting the real 14 Bakr/Candlestix agents to
  managed-session definitions) — explicitly out of scope per the ticket.
- **No `fs.watch`/inotify** — polling only, same `filesystem`-provider
  precedent, same reasons (`docs/filesystem.md`'s own "Not in this
  version").

## Query-based agents are free-form (non-goal, recorded on the epic)

Per BUTCHR-391's own epic-level decision: filesystem-provider definitions
(managed sessions included) do NOT get butchr's upstream/downstream
boss/worker model. No `Implements` links, no `report_to_boss`/
`submit_to_boss` routing, no `childRule`/`inwardConnectionRules` wiring. A
managed-session agent does its own Jira/Confluence work (if any) directly
through an operator-configured Atlassian MCP connection, never through
butchr's `jira_*`/`confluence_*` tools or the boss verbs — butchr's
hierarchy verbs are for jira-work ticket agents (Epic/Story/Task) only.
