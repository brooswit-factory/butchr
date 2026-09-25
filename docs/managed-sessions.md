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
| `freezeControllers` | no | OTHER definitions (by file name, with or without `.json`) whose agent may call the butchr `freeze_session` MCP tool against THIS one. Absent/empty means nobody may. See "Delegated freeze/unfreeze" below. |
| `unfreezeControllers` | no | Same shape, for `unfreeze_session` — an INDEPENDENT list; a name in `freezeControllers` grants nothing here, and vice versa. |

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
2. A path whose percent-encoded id would overflow the workspace
   directory-name limit is skipped and logged once — the SAME 255-byte
   check and discipline `filesystem` already applies to every resource
   (`docs/filesystem.md`'s own "Resource identity" section).
3. A file that fails to parse or validate is skipped and logged once
   (`WARNING: [managed-sessions] <path> is not a valid definition, never
   staffed: <problems>`) — never staffed, never silently dropped, never
   crashes the poll; a sibling definition's own validity is unaffected.
4. A file that parses and validates but is `frozen: true` is skipped and
   logged once, DISTINCTLY from an invalid one (`[managed-sessions] <path>
   is frozen — no agent runs`) — frozen is a property of a valid
   definition, not a kind of invalidity.
5. Everything left is eligible: one `filesystem`-provider agent per
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

## The `butchr session` CLI (BUTCHR-454)

There is now an operator CLI for the whole lifecycle above short of
archive/unarchive (a later story, BUTCHR-394 T2): `butchr session
list|show|create|freeze|unfreeze`, credential-free and daemon-free, exactly
like `butchr link`'s own precedent (`src/cli/link-cli.ts`) — dispatched from
a guard at the very top of `src/daemon/index.ts`, before config/rules
loading. A managed-session definition is local filesystem state (plus the
`drovr-events` freeze store below), so none of these verbs need a live
daemon, Jira credentials, or a rules file.

```
usage: butchr session list
       butchr session show <name>
       butchr session create <name> --working-directory <dir> --brief <text>
                             --vendor claude|codex --tier tier1..tier5
                             --permission-mode default|acceptEdits|bypassPermissions|plan|auto
                             [--execution swarm|singleton|persistent]
                             [--account none|temporary|permanent]
                             [--role worker|sentinel] [--frozen]
                             [--mcp-servers <json array>]
                             [--freeze-controllers <comma-separated names>]
                             [--unfreeze-controllers <comma-separated names>]
       butchr session freeze <name>
       butchr session unfreeze <name>
```

`<name>` is a definition file's basename, with or without `.json`, resolved
against the same well-known directory `sessionDefinitionsPath()` resolves
(`BUTCHR_SESSION_DEFINITIONS_DIR`, else `$XDG_CONFIG_HOME/butchr/session-
definitions`).

- **`list`** enumerates every direct-child file of that directory — the
  SAME candidate set `searchSessionDefinitions` walks (same query, same
  255-byte encoded-path cap) — but, unlike the daemon's own poll, an
  invalid or oversized definition is listed too, WITH its problems, never
  dropped: "eligible" is the daemon's own filter, not this command's. Each
  row also names both freeze gates (see "Two freeze gates" below) and both
  delegated-freeze grants (`(none)` when unset).
- **`show <name>`** is one `list` row's full detail: parsed
  vendor/tier/role/execution (when valid; every collected problem
  otherwise), the resolved filesystem agent key, both freeze gates, and
  both delegated-freeze grants.
- **`create <name> ...`** validates through `sessionDefinitionProblems` —
  the EXACT function `parseSessionDefinitionFile` (and so the daemon's own
  poll) runs a manifest through, never a forked copy of the schema — then
  writes the fields AS GIVEN (a `~`-prefixed `workingDirectory` is written
  back as `~...`, never daemon-expanded; an omitted optional field stays
  omitted, never defaulted onto disk) via a temp-file-then-`rename` in the
  SAME directory (`src/resources/atomic-write.ts`), so the daemon's ~15s
  poll (`MANAGED_SESSIONS_POLL_MS`) never observes a half-written file.
  Refuses outright if a definition of that name already exists. **Does
  NOT yet check an archived location of the same name** — archive/unarchive
  (BUTCHR-394 T2) hasn't defined where "archived" lives yet; this is a
  known gap to close once that location exists, not an oversight.
  `--freeze-controllers`/`--unfreeze-controllers` (BUTCHR-456) set the two
  delegated-freeze grants at creation — see "Delegated freeze/unfreeze"
  below. There is deliberately no CLI verb to change a grant after
  creation: edit the manifest file directly (or recreate it) and let the
  daemon's own ~15s poll pick it up.
- **`freeze <name>` / `unfreeze <name>`** flip both freeze gates (below),
  in the decided order, and print a note that the effect reaches a running
  daemon within one poll (`MANAGED_SESSIONS_POLL_MS` = 15s) — or, if no
  daemon is currently running, the next time one starts. **The CLI never
  stops an agent itself** — only the running daemon's own reconcile
  (`reconcileNow`) plus `watchInstanceFreeze` do that; this command only
  changes state for the daemon to observe.

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
persistent definition (the 10 CNDLX-45 MUD players) stay frozen through a
future archive/restore move (BUTCHR-394 T2), even though that changes the
store key entirely. **A caveat this implies:** archive/unarchive must
restore a manifest's exact original filename, or a store-only-frozen
definition (one whose manifest flag was never separately set) loses that
protection on the move — recorded here for T2, not solved by this ticket.

`freezeSessionDefinition`/`unfreezeSessionDefinition`
(`src/resources/session-freeze.ts`) are plain, argv/stdout-free core
functions for exactly this reason — the `freeze_session`/`unfreeze_session`
MCP tools below (for delegated freeze control, e.g. `director-brooswit-mud`)
call them directly, unchanged; `butchr session freeze`/`unfreeze` is a thin
CLI layer over the same two functions, not a second implementation.

## Delegated freeze/unfreeze (BUTCHR-456, BUTCHR-394 T3)

CNDLX-45 needs an agent, `director-brooswit-mud`, that can freeze and
unfreeze the 10 MUD-player managed-session definitions — and ONLY those —
without butchr trusting anything the director agent argues about its own
identity. This ticket builds that CAPABILITY: two MCP tools, `freeze_session`
and `unfreeze_session`, scoped by an explicit, per-definition grant the
OPERATOR writes. It creates no live grant, definition, or freeze state
itself — migrating the real 10 MUD players is a separate, later step.

### Why the tool boundary, not a file check

A CLI, or any same-Unix-user process editing the definitions directory
directly, cannot be bounded by anything butchr controls — there is no
signal at that layer to check identity against. So scoping instead lives at
the **butchr MCP TOOL boundary**, where a caller's identity comes from the
daemon-written per-agent MCP config header (`x-butchr-agent`; see
`src/mcp/identity.ts`'s `callerIdentity`, and `mcpIdentityHeaders` /
`src/agents/workspace.ts` for how a managed-session agent's own workspace
gets that header baked in at spawn time — never something the agent
supplies itself as a tool ARGUMENT).

**This is an honest TOOL-BOUNDARY guarantee, not an OS-level one — and the
header itself is part of that same OS-level boundary, not above it.** The
header lives inside the agent's own daemon-written workspace config —
`mcp.json` for a Claude launch, the launched process's own argv for Codex
(`agentLaunchConfig`, `src/agents/argv.ts`) — so an agent WITH SHELL ACCESS
to its own workspace could in principle read or alter that file/process
state, same as it could edit its own manifest directly; nothing here claims
otherwise. Any process that can write the definitions directory directly —
a shell command run by the SAME managed-session agent, another process
under the same Unix user, an operator by hand — can still flip a `frozen`
field or edit a grant directly, exactly as before this ticket. What this
capability actually buys: an agent that has ONLY MCP tools (no shell, no
filesystem write access of its own to the definitions directory) can still
be delegated a narrow, auditable freeze/unfreeze capability over specific
OTHER definitions, without that agent — or anyone spoofing its ARGUMENTS —
being able to touch anything else. The guarantee is against argument-level
spoofing between agents, never against what an agent's own shell can do to
itself.

### The grant: `freezeControllers` / `unfreezeControllers`

Two new optional fields on a managed-session definition (validated by the
SAME `sessionDefinitionProblems` validator every other field goes through —
see the manifest format table above): `freezeControllers: string[]` and
`unfreezeControllers: string[]`. Each entry names a CONTROLLER definition by
FILE NAME (with or without `.json`; `"a"` and `"a.json"` are the same
entry for duplicate-checking purposes) — never a path. A definition never
needs to list itself, but nothing rejects that; it is simply a no-op grant.

```json
{
  "workingDirectory": "/opt/mud/player-1",
  "brief": "Play the MUD.",
  "vendor": "claude",
  "tier": "tier2",
  "permissionMode": "default",
  "freezeControllers": ["director-brooswit-mud"],
  "unfreezeControllers": []
}
```

Here, `director-brooswit-mud` may call `freeze_session` against this
definition, but NOT `unfreeze_session` — `unfreezeControllers` is empty, so
nobody may unfreeze it via the MCP tool (an operator still can, directly).
**Freezing and unfreezing are deliberately two separate grants, never one
list:** per CNDLX-45's own decision, migrating the 10 MUD players onto
managed sessions only requires the director to be able to FREEZE them (to
protect the migration); whether it may also UNFREEZE them is a separate,
explicit judgment call for the director agent's own owners and Brooswit to
make later, not a byproduct of this ticket. Listing a controller in
`freezeControllers` gives it NOTHING on `unfreeze_session`, and listing it
in `unfreezeControllers` gives it nothing on `freeze_session` — verified by
`test/unit/session-freeze-tools.test.ts`'s own "the two grants are
independent" cases.

**There is deliberately no MCP tool or CLI verb that lets an agent modify a
grant.** `freeze_session`/`unfreeze_session` can only flip the two freeze
gates on an already-granted target — never create, archive, delete, or
edit any definition, including the grant fields themselves. A grant changes
only when the OPERATOR edits the manifest file directly, or supplies
`--freeze-controllers`/`--unfreeze-controllers` to `butchr session create`
(see the CLI section above) — there is no "update grant" CLI verb either;
recreate or hand-edit the file.

### `freeze_session` / `unfreeze_session`

Two MCP tools on the butchr MCP server (`src/tools/session-freeze-tools.ts`),
each taking a single argument, `name` — the TARGET definition's file name
(with or without `.json`), resolved the same with-or-without-extension way
`butchr session show/freeze/unfreeze` already resolve a name. Available to
a managed-session (`filesystem` provider, the built-in `managed-sessions`
rule id) agent of **either** vendor — `claude` or `codex` — identically:
authorization never looks at vendor at all, and a Codex agent already
receives butchr's full MCP tool list the same way a Claude agent does (a
`mcpServers` entry in its own launch config, `src/agents/argv.ts`'s
`agentLaunchConfig` — not the `mcp.json` FILE, which is Claude-specific
wiring; both paths carry the identical `x-butchr-agent` header via the same
`mcpIdentityHeaders`).

**Authorization, checked entirely server-side, never from anything the
caller's arguments claim:**

1. The caller's identity is decoded from its OWN connection header
   (`x-butchr-agent`), never from the tool call's arguments — there is no
   argument that could name "who I am" in the first place; the input
   schema is `{ name }` and `name` always means the TARGET, never the
   caller.
2. The caller must decode as a managed-session agent specifically:
   `resourceProvider: "filesystem"`, rule id `managed-sessions` (the
   built-in rule's own reserved id — see `MANAGED_SESSIONS_RULE_ID`). A
   query-level agent (no single resource), a plain BUTCHR-407 `filesystem`
   agent under some OTHER rule, or any non-`filesystem` provider (a
   `jira-work` ticket agent, a `github-issue` agent, …) is refused, same as
   a caller with no identity at all.
3. The target name is resolved against the SAME `listSessionDefinitions`
   walk `butchr session list`/`show` already use — which is itself the
   SAME `listFilesystemResources` walk the daemon's own
   `searchSessionDefinitions` uses to build a match's `agentKey`. This is
   why name resolution is inherently path-safe rather than merely
   pattern-checked to be: a `FilesystemResource.name` is always a bare
   basename of a REAL direct child of the definitions directory, with no
   path separator, and NEVER a symlink (`listFilesystemResources`'s own
   walk skips every symlink outright — `src/resources/filesystem.ts`). A
   `name` containing `/`, `..`, an absolute path, or naming a symlink
   therefore cannot equal any real entry's name and simply fails to
   resolve, refused with the exact same message as an unknown name — never
   a special-cased rejection with its own text (see "Refusals never
   distinguish" below). It also means the resolved path this tool hands to
   `freezeSessionDefinition`/`unfreezeSessionDefinition` is byte-identical
   to what the daemon's own poll would use for the same file, so the
   freeze-store key can never diverge from the key `HerdrHerd.frozen()`
   reads.
4. The target must be a VALID definition (parses through
   `sessionDefinitionProblems` with no problems) — an invalid target's
   grant fields cannot be trusted to mean anything, same reasoning
   `manifestFrozen: undefined` already applies to an invalid `list`/`show`
   row.
5. The target's own `freezeControllers` (for `freeze_session`) or
   `unfreezeControllers` (for `unfreeze_session`) must contain a name that
   resolves (through that SAME walk) to an agent key equal to the caller's
   own — the exact `sessionAgentKey` codec `searchSessionDefinitions`
   already uses to build a match's `agentKey`, compared as opaque strings,
   never re-derived by hand in the tool itself.

On success, the tool calls straight into `freezeSessionDefinition`/
`unfreezeSessionDefinition` UNCHANGED — the same two gates, same order,
same idempotency `butchr session freeze`/`unfreeze` already gives you (see
"Two freeze gates" above). A delegate can only flip those two gates; it can
never create, archive, delete, or edit anything else about any definition,
including its own grant.

### Refusals never distinguish why

An unknown target name, an invalid/unparseable target, a caller with no
grant on that target, and a caller that isn't a managed-session agent at
all (a `jira-work` ticket agent, another provider, no identity, a malformed
agent key) all throw the **exact same** refusal message, per verb — never
a message that would let a probing caller learn which definitions exist or
who controls them. `unfreeze_session`'s message differs from
`freeze_session`'s (it names the OTHER grant field), but is equally uniform
across every one of ITS OWN failure shapes. Pinned in
`test/unit/session-freeze-tools.test.ts`'s "every refusal reads
identically" cases.

### Docs and CLI surface

`butchr session create` gained `--freeze-controllers`/
`--unfreeze-controllers` (comma-separated definition names) to set the
grant fields at creation; `butchr session list`/`show` display both grants
(`(none)` when unset) — see the CLI section above. This doc's own manifest
format table above also lists both fields.

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
  every provider alike.
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
