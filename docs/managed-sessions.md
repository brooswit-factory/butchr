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
| `strictMcpConfig` | no | BUTCHR-453/BUTCHR-463. Boolean, Claude only. `true` reaches a Claude launch's `ClaudeAgentLaunch.strictMcpConfig` (`@brooswit/drovr` >= 0.14.0), emitting `--strict-mcp-config` alongside `--mcp-config` — Claude Code then loads ONLY this agent's own `mcp.json`, no project- or user-level `.mcp.json` discovery on top of it. Absent/`false`: no flag, ordinary discovery. **Rejected at manifest load for `vendor: "codex"`** — see "Per-vendor launch differences" below for why this is a deliberate departure from `permissionMode`'s own precedent. See "Auto + strict MCP" below for the worked Candlestix-director example, and "Nexus's MCP isolation constraint" for how this relates to `assertNoInheritedMcpConfig`. |
| `execution` | no | Reuses `Rule`'s `ExecutionMode` type/validation VERBATIM (`"swarm"` default). Stored, surfaced — NOT acted on by this ticket; see "Not in this version". |
| `account` | no | Reuses `Rule`'s `AccountPolicy` type/validation verbatim (`"none"` default). BUTCHR-460: wired, same as every other provider's rule-level `account` — a `"temporary"`/`"permanent"` definition gets a Rocket.Chat account provisioned at spawn and released on stop/archive; see `docs/rocketchat-accounts.md`'s "Wiring" section. |
| `role` | no | Reuses `Rule`'s `AgentRole` type/validation verbatim (`"worker"` default, `"sentinel"` for fleet-cap-exempt agents — e.g. Candlestix directors, MUD players). Read by the fleet-cap admission classifier — see "role -> fleet-capacity admission" below. |
| `frozen` | no | `false` default. A frozen definition is a VALID one that simply runs no agent — see "Eligible = valid, not frozen" below. |
| `mcpServers` | no | Additional MCP servers this agent may connect to, beyond butchr's own — see "`mcpServers`: additional MCP server bindings" below. |
| `freezeControllers` | no | OTHER definitions (by file name, with or without `.json`) whose agent may call the butchr `freeze_session` MCP tool against THIS one. Absent/empty means nobody may. See "Delegated freeze/unfreeze" below. |
| `unfreezeControllers` | no | Same shape, for `unfreeze_session` — an INDEPENDENT list; a name in `freezeControllers` grants nothing here, and vice versa. |
| `linkedEventingProjects` | no | FACTORY-52. Non-empty array of canonical `jira-project:<KEY>` references naming the Jira project(s) this definition opts into linked eventing for. See "`linkedEventingProjects`: per-definition linked-eventing project opt-in" below. |

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
header — `buildWorkspace`). A **Codex** agent NEVER gets `headersEnvVar`'s
resolved value, regardless of the binding — Codex's launch argv is a real
process command line any other local user can read via `ps`/`/proc`, and
Drovr renders a Codex header as literal argv text. **BUTCHR-413 narrows
this one specific case**: a binding's `accountHeader` (a non-secret
per-agent account NAME, never a credential) IS resolved for Codex the same
way it is for Claude — see `docs/mcp-server-bindings.md`'s "Codex" section
for the shipped mechanism.
**This is why BUTCHR-408's own Codex staged example (scenario (c)) never
depends on an authenticated bound server** — at the time S2 shipped, no
bound server was reachable with any header at all from Codex; a bridge that
only sets `headersEnvVar` (a secret) still is not, but one that sets
`accountHeader` (like rocketr) now is (BUTCHR-413). The per-MCP
"notification flag" the ticket's own text names is `channel`, exactly as
S4 designed it; nothing else was added on top.

Channel **delivery** to a non-Claude vendor through Codex's OWN connection
is still out of scope for this ticket — see "Not in this version"
(BUTCHR-413 later added a daemon-side relay that delivers `channel: true`
push as a `herd.nudge` prompt instead, without Codex's own connection ever
receiving it — see `docs/codex-channel-relay.md`).

### `linkedEventingProjects`: per-definition linked-eventing project opt-in

FACTORY-52 (epic FACTORY-51, story implementing FACTORY-52). An optional
field naming one or more Jira projects this definition's agent should get
linked eventing for, in the canonical `jira-project:<KEY>` vocabulary
`src/resources/resource-ref.ts` (`parseResourceRef`/`formatResourceRef`)
already defines and every other resource ref in this codebase already
reuses:

```json
{
  "workingDirectory": "~/code/brooswit-factory/some-project",
  "brief": "Keep this repo's docs and dependency versions current.",
  "vendor": "claude",
  "tier": "tier1",
  "permissionMode": "default",
  "linkedEventingProjects": ["jira-project:FACTORY"]
}
```

- **Shape:** a non-empty array of strings; each entry must parse as a
  canonical `jira-project:<KEY>` reference — a bare key with no provider
  prefix (`"FACTORY"`) is rejected, same as everywhere else this codebase
  requires the canonical form rather than a shorthand. Only the
  `jira-project` provider is accepted; naming any other kind of resource
  (`jira-work-item:...`, `github-issue:...`, ...) is rejected with a message
  naming the provider it actually parsed as.
- **Validation, not silent correction:** a malformed key, the wrong
  provider, a non-array value, an empty array, or a non-string entry each
  produce a clear load-time problem (collected alongside every other
  problem on the manifest, same one-pass discipline as every other field).
  Duplicate entries — compared by CANONICAL form, so the same project
  written twice, or written once upper-case and once lower-case, collides —
  are rejected outright rather than silently deduped, the same "reject,
  never silently drop" choice `freezeControllers`/`unfreezeControllers`
  already make for their own duplicate entries.
- **Exposed value:** `SessionDefinition.linkedEventingProjects` (when
  present) is the array of CANONICAL `jira-project:<KEY>` strings — not bare
  project keys — so a consumer already working in `ResourceRef`/canonical-
  string terms elsewhere in the codebase needs no separate parsing step to
  use it.
- **Additive:** a definition WITHOUT this field parses and behaves exactly
  as it did before this field existed — no key materialises on the parsed
  object, no extra search, no extra state.
- **Deliberately not a reuse of `Rule.linkedEventing`:** that field is a
  per-RULE boolean with no project of its own to name (a `Rule` already
  owns whichever resources its query matches); a managed-session definition
  has no owning `Rule` in the same sense and needs to say WHICH project(s),
  not merely whether — hence a dedicated, project-naming field here instead
  of trying to bolt a boolean onto a definition that has nothing for it to
  apply to.
- **Wired (FACTORY-53/FACTORY-71, epic FACTORY-51):** naming a project here
  actually nudges this definition's agent now — see
  `docs/resource-links.md`'s "Managed-session linked eventing" section for
  the full behaviour (what fires a nudge, the rate cap, and how a frozen
  session is excluded). `createManagedSessionResourceType`'s own `related`
  hook (`src/rules/session-definition-type.ts`) builds one
  `ProjectLinkedEventingMatch` per opted-in project and feeds it straight
  into the SAME `createLinkedEventingState`/`runTick` machinery
  (`src/jira-watch/linked-eventing.ts`) a `jira-project` rule's own owners
  already use — no second watcher, no separate rate cap.

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
                             [--freeze-controllers <comma-separated names>]
                             [--unfreeze-controllers <comma-separated names>]
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
  row also names both freeze gates (see "Two freeze gates" below) and both
  delegated-freeze grants (`(none)` when unset). Plain `list` **never**
  shows an archived definition — pass `--archived` for that (see
  "Archive/unarchive" below).
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
  Refuses outright if a definition of that name already exists **in either
  the active directory or the archive directory** (BUTCHR-455 closes the
  gap BUTCHR-454 flagged: creating a name that collided with an archived
  definition used to succeed, and a later `unarchive` of that name would
  then collide with the new active file it never knew about).
  `--freeze-controllers`/`--unfreeze-controllers` (BUTCHR-456) set the two
  delegated-freeze grants at creation — see "Delegated freeze/unfreeze"
  below. There is deliberately no CLI verb to change a grant after
  creation: edit the manifest file directly (or recreate it) and let the
  daemon's own ~15s poll pick it up.
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

### Post-archive hook seam (present, deliberately left a no-op — release is wired daemon-side instead, BUTCHR-460)

`archiveSessionDefinition` accepts an injected `onArchived({ agentKey,
path })` async hook, default no-op, run once after a successful move. This
was built for S4 (BUTCHR-395), which owns Rocket.Chat account cleanup
(`releaseAccount(agentKey, "archive")`, `src/accounts/manager.ts`) — that
release is now wired and real (`docs/rocketchat-accounts.md`'s "Archive
release" section), but NOT through this hook: `butchr session archive` is a
credential-free, daemon-free CLI process with no Rocket.Chat client, account
store, or Nexus manifest publisher to call `releaseAccount` with (see that
same doc section for the full reasoning — a CLI-side release would mean a
second process racing the daemon's own store writes, and a manifest that
stays stale until some unrelated later batch republished it). The real
release happens daemon-side: the managed-sessions loop notices the
definition disappeared from `desired` (this move already causes that, on the
daemon's own next poll) and, before falling through to an ordinary `"stop"`
release, checks whether a same-basename file now exists in the archive
directory — a positive check upgrades the release to reason `"archive"`.
This ALSO covers an archive done by hand-moving the file, which no CLI-side
hook could ever see. `onArchived` therefore stays a documented no-op here —
this section is the "not yet wired" note's successor, not a removal of the
seam itself: a future caller (a hypothetical MCP archive tool, symmetric to
`freeze_session`/`unfreeze_session`) still gets the hook for free, same as
before. A hook failure is reported loudly (the CLI prints it to stderr, and
the core function surfaces it as `ArchiveResult.hookError`) but **never
undoes the move** — by the time the hook runs, the definition is already out
of the eligible set, and rolling the file back on a hook failure would
silently re-enter it into the eligible set for a reason (account cleanup)
unrelated to whether the move itself was valid. The hook is never called on
a refusal, and `unarchive` has no hook parameter at all (this seam is
one-directional: S4's cleanup is an archive-time concern).

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
project-level `.mcp.json` auto-discovery, never exclusive of it — and, prior
to BUTCHR-453/BUTCHR-463, this codebase (and `@brooswit/drovr`, its launch
layer) never passed `--strict-mcp-config` anywhere at all, so this direction
was the ONLY mitigation for the project-level case. That is no longer true:
a definition can now set `strictMcpConfig: true` (see "Auto + strict MCP"
below) to ask Claude Code for real exclusive discovery — but direction 2
remains load-bearing on its own, because `strictMcpConfig` is opt-in per
definition, while `assertNoInheritedMcpConfig` below is unconditional for
every managed-session spawn regardless of that field. Claude Code's own
discovery is understood to walk UP from the
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

## Auto + strict MCP: the Candlestix directors' shape (BUTCHR-453/BUTCHR-463)

The 3 Candlestix directors run with `permissionMode: "auto"` and a strict MCP
config today. Migrating them to managed-session definitions faithfully means
expressing BOTH properties in one manifest:

```json
{
  "workingDirectory": "~/candlestix/factory-director",
  "brief": "Direct the factory channel.",
  "vendor": "claude",
  "tier": "tier2",
  "permissionMode": "auto",
  "strictMcpConfig": true,
  "role": "sentinel"
}
```

`permissionMode: "auto"` reaches Claude's launch exactly as any other
`permissionMode` value does (see "Per-vendor launch differences" below).
`strictMcpConfig: true` additionally emits `--strict-mcp-config` alongside
`--mcp-config`, so Claude Code loads ONLY the servers in this agent's own
`mcp.json` (butchr's own server plus any `mcpServers` this definition binds)
— no project- or user-level `.mcp.json` discovered on top of it. `role:
"sentinel"` is unrelated to either field but part of the directors' real
shape (fleet-cap-exempt) — included here so the example is the complete
faithful migration, not just the MCP/permission slice of it.

**How this relates to `assertNoInheritedMcpConfig` (direction 2, above):**
the two are complementary, not redundant. `assertNoInheritedMcpConfig` is
unconditional and PROJECT-level only — it refuses the spawn outright if any
ancestor of the launched workspace directory carries a `.mcp.json`, for
EVERY managed-session agent regardless of `strictMcpConfig`. `strictMcpConfig`
is opt-in and covers the wider case direction 2 explicitly does not: Claude
Code's own USER-level MCP config (outside any project directory), which no
amount of ancestor-walking can exclude — only `--strict-mcp-config` itself
does. A director definition wants both: `assertNoInheritedMcpConfig` closes
the project-level gap unconditionally, `strictMcpConfig: true` closes the
user-level one this definition explicitly asks for.

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

`strictMcpConfig` reaches a **Claude** launch's `ClaudeAgentLaunch.strictMcpConfig`
verbatim (Drovr >= 0.14.0, `@brooswit/drovr`; also validated at our layer —
a non-boolean value fails at manifest-load time). **Codex** has no
strict-MCP-config concept either, but is treated DIFFERENTLY from
`permissionMode` above: a `vendor: "codex"` definition setting
`strictMcpConfig` (to any value, including `false`) is **REJECTED at
manifest load** (`sessionDefinitionProblems`,
`src/resources/session-definition.ts`) rather than silently validated,
stored, and dropped. This is a deliberate departure from `permissionMode`'s
own precedent, not an oversight: a silently-ignored `permissionMode` leaves
a Codex operator with a cosmetic surprise (their manifest's wish is a
no-op), but a silently-ignored `strictMcpConfig` would leave them believing
they have an MCP-isolation security property they do not — the exact
silent-loss-of-isolation failure mode BUTCHR-453 exists to close in the
first place. `test/unit/session-definition.test.ts` proves the rejection.

## Not in this version

- ~~S4's own channel DELIVERY to a non-Claude vendor~~ **BUTCHR-413: Codex's
  own connection still gets no push, but the agent isn't left with
  nothing.** The `mcpServers`/`channel` field and its Claude-side wiring are
  real (see "`mcpServers`: additional MCP server bindings" above); a Codex
  agent's own MCP connection to a bound server still only ever gets tools,
  never push — that much of S4's original scoping holds. What no longer
  holds is reading "Codex steering is a later story" as "nothing exists
  yet": BUTCHR-413's daemon-side relay (`src/notify/codex-channel-relay.ts`,
  `docs/codex-channel-relay.md`) holds a `channel: true` bound server's
  notification stream open on the agent's behalf and delivers each push as
  a `herd.nudge` prompt instead — a deliberate stopgap BUTCHR-359 (still out
  of scope here) is meant to subsume.
- ~~The Rocket.Chat account lifecycle (`account: "temporary"|"permanent"`)~~
  **BUTCHR-460: now wired**, same as every other provider — see the
  `account` field's own table row above and `docs/rocketchat-accounts.md`'s
  "Wiring"/"Archive release" sections for the full design, including WHY
  the release path runs daemon-side rather than through
  `archiveSessionDefinition`'s `onArchived` hook (see "Post-archive hook
  seam" above, which now describes what actually happens).
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

## Escalating an unanswerable startup dialog (FACTORY-45)

The daemon's existing prompt-escalation machinery (`onBlocked`,
`src/agents/escalation-loop.ts`) posts an unanswerable Claude Code dialog as
a comment on the blocked agent's own Jira/GitHub/Zendesk issue. A
managed-session agent has no such issue — it is identified only by its
definition file's own path — so `onBlocked` is called with `issue === null`
for it, same as for any other keyless pane. This section is about what
happens THEN, for a managed session specifically; every other keyless pane
(an unowned/legacy workspace, a query-level agent, …) is unaffected and
keeps the plain `"... blocked with an unanswerable prompt but no issue key —
cannot escalate"` log line it always had.

**Drovr's own auto-answering is deliberately NEVER USED here — Butchr's
own dialog-answering remains the SOLE answerer, fleet-wide, unchanged by
this ticket.** `@brooswit/drovr` (this repo's own dependency, pinned
>= 0.15.0) DOES recognize and — left to its own devices — press several
`startup` dialogs (trust, development-channels, auto-mode-onboarding, and
its own SPECULATIVE `fullscreen-renderer` matcher for the "didn't finish
starting" recovery notice — see that package's own
`docs/blocking-escalation.md`, and NOT to be confused with the separate
"Try the new fullscreen renderer?" opt-in offer, which Butchr's own
`chooseStartupAnswer` already answers and drovr's release does not touch
at all). Running that auto-answering fleet-wide, independently and on its
own 5s cadence alongside Butchr's own `watchPrompts`, was measured as a
real hazard during this ticket's own review, not a hypothetical one:
startup dialogs arrive in sequence (trust, then development-channels), a
slow redraw can let both answerers read the SAME still-visible dialog, and
the second answerer's keys then land on the NEXT dialog instead — an
identical `down`+`enter` that correctly picks "Yes, I trust this folder"
on the trust dialog would instead move to and confirm "Exit" on
development-channels, killing the launch. So `createManagedSessionEscalationWatcher`
(`src/agents/managed-session-escalation-watcher.ts`) hands drovr's watcher
a client whose `sendKeys` is UNCONDITIONALLY a no-op — `list`/`read` pass
through to the real herdr client untouched, so drovr's own detection and
classification still work exactly as documented, but NOTHING it recognizes
is ever pressed. Only its ESCALATION half (the host-neutral hook, below)
is consumed. Butchr keeps no dialog list of its own, and never presses one
of drovr's own recognized dialogs on its behalf — see "Two detectors, one
mark" further down for what "two" means once neither one is an answerer.

Two INDEPENDENT paths feed the SAME minimal escalation below:

- **Butchr's own detection** (unchanged by this section): `watchPrompts`
  (`src/agents/prompt.ts`/`src/agents/prompt-watch.ts`) already decided it
  cannot auto-answer a dialog (via Butchr's own `chooseStartupAnswer` — the
  SOLE answerer, per above), and calls `onBlocked` with `issue === null`.
- **Drovr's own detection** (FACTORY-45 Part B): a separate poll loop
  (`src/daemon/index.ts`) calls `createManagedSessionEscalationWatcher(escalator)`'s
  `.poll(herdr)` every 5s over the WHOLE fleet; for a dialog its own
  `classifyBlockingScreen` reads as genuinely `unknown` (with a verbatim
  `question`/`options`), `hook.onUnknownDialog` fires exactly once per
  (pane, fingerprint) episode in DROVR's OWN closure, and
  `hook.onDialogResolved` fires once that episode clears. A `startup`/
  `permission` dialog it also recognizes is reported internally to drovr
  itself (never pressed, per above) but never reaches Butchr's hook at
  all — only a genuinely `unknown` dialog does.

Either path resolves the SAME one question — is this pane a managed
session? — through the SAME seam: `createEscalator`'s
`EscalatorDeps.managedSessionOf` (injected in production as
`managedSessionOfPane`, `src/daemon/index.ts`), which resolves a keyless
pane's cwd back to its herd id (`agentIdOfWorkspacePath`) and checks it
against the built-in `managed-sessions` rule (`ownsManagedSessionAgent`,
`src/rules/session-definition-type.ts`). Only when that resolves — i.e. the
pane is genuinely a filesystem-provider managed-session agent — does
anything beyond the plain log line happen:

1. **A greppable journal line**, logged once per (pane, dialog fingerprint)
   episode, prefixed `[managed-escalation]` (`MANAGED_ESCALATION_MARKER`,
   distinct from this module's ordinary `[prompts]` line so it survives a
   `journalctl --user -u <unit> | grep managed-escalation` regardless of how
   noisy the ordinary prompt log is — the unit name is in your own
   workspace's `ENVIRONMENT.md`, never hand-copied from someone else's). It
   names the agent key, the definition file's own path, the pane id, the
   dialog's question and numbered options VERBATIM, its fingerprint, and
   (FACTORY-50 Part C) the path of the pane-text capture just written, when
   one was — everything an operator needs to find the pane and decide what
   to do, without a second lookup.
2. **A "stalled" mark on `/health`**: every currently-stalled managed
   session appears in a `managedSessionEscalations` array (a SIBLING field
   on the `/health` response, the same "additive, never flips `ok`" pattern
   `admission`/`coverage`/`unresolvedRelationships` already use —
   `src/daemon/health.ts`) — `{ agentKey, definitionPath, paneId,
   fingerprint, since }` per entry. This is the status SURFACE an operator
   finds a blocked managed session on without grepping the journal first;
   `Escalator.managedSessionEscalations()` (the in-memory tracker this
   reads) is the single source of truth for it — no separate storage was
   invented for this ticket.
3. **Dedupe**: once logged/marked for a given (pane, fingerprint), a later
   poll with the SAME fingerprint is a no-op — neither re-logs nor
   re-marks. A NEW fingerprint on the same pane (the dialog changed while
   still blocked) escalates again, overwriting the stale entry. Unlike the
   keyed-issue flow's own restart-safe adoption (which re-reads its Jira
   comment to recognize its own prior escalation), this dedupe is in-memory
   only: a daemon restart mid-episode re-logs once for a dialog that is
   still up. Accepted deliberately, given this ticket's reduced scope — a
   duplicate journal line costs nothing a Jira rate cap would need to guard
   against.
4. **Resolution**: when the herd no longer reports the pane blocked AT ALL
   (`Escalator.onPoll`'s existing per-tick reset, which already ends every
   other debounce/episode tracker in this module the same way), the entry is
   removed from `managedSessionEscalations()` and one more
   `[managed-escalation] ... no longer blocked — clearing stalled mark` line
   is logged. The SAME fingerprint reappearing after a genuine clear is
   treated as a fresh episode (it escalates and logs again), never silently
   suppressed.
5. **A durable pane-text capture** (FACTORY-50 Part C) — see "Pane-text
   capture" just below.

### Pane-text capture (FACTORY-50 Part C)

A journal line alone can truncate or mis-parse the real screen — exactly
what happened to the dialog that opened FACTORY-44 (pane gone, nothing but a
hand transcription survived it). For a genuinely NEW (pane, fingerprint)
episode — never a no-op re-entry on the same fingerprint — Butchr now also
writes the pane's full, unredacted, ANSI-stripped text to the SAME local
capture store BUTCHR-16 built for the keyed-issue escalation flow
(`EscalatorDeps.captures`, real implementation `createCaptureStore`,
`src/agents/capture-store.ts`; directory resolved by `config.captureDir` —
`BUTCHR_CAPTURE_DIR` if set, else `<BUTCHR_WORKSPACES>/.captures`, printed by
the daemon at startup and readable from your own workspace's
`ENVIRONMENT.md`/journal, never hand-copied from someone else's).

- **Filename**: `<agentKey>-managed-escalation-<paneId>-<compact-UTC-timestamp>.txt`,
  e.g. `filesystem:managed-sessions:%2Fhome%2Fbutchr%2F.config%2Fbutchr%2Fsession-definitions%2Fadmin-brooswit-nexus.json-managed-escalation-w4:p4H-20260926T153100Z.txt`.
  The agent key is already `encodeURIComponent`-escaped per component
  (`encodeAgentKey`, src/rules/agent-key.ts), so it needs no further
  sanitizing to be filename-safe. This shape is deliberately disjoint from
  the keyed-issue escalation capture (`<ISSUE>-escalation-<ts>.txt`) and
  session-limit-watch's own captures (`<ISSUE>-unrecognised-<ts>.txt` /
  `<ISSUE>-no-reset-time-<ts>.txt`) — there is no issue/project key here at
  all — so none of the three ever lists, evicts, or is evicted by, either
  of the others. A definition path deep/long enough to push the full
  filename past the filesystem's own 255-byte name limit fails the write —
  handled the same as any other write failure (see "Failure handling"
  below), never a crash.
- **Contents**: a short `#`-commented header (agent key, definition path,
  pane id, dialog fingerprint, capture time) followed by the pane's full
  text verbatim, UNREDACTED — local disk only, never posted anywhere (there
  is no ticket to post it to).
- **Retention**: capped at 50 files of this shape at once (mirrors both
  sibling capture kinds' own cap); the oldest, by the timestamp embedded in
  the filename, is evicted first once a new capture would exceed it. Only
  files matching this exact shape count toward the cap — a shared capture
  directory holding the other two kinds' files, or anything else, is never
  touched by this eviction.
- **Failure handling, and the timeout that bounds it**: a capture that
  ERRORS (disk full, permission error, …) is logged once (`WARNING:
  [managed-escalation] capture failed for pane ...`) and never blocks or
  delays the `[managed-escalation]` journal line itself. A capture that
  instead HANGS — the pane read this reuses (`herdr.pane.read`) carries no
  deadline of its own, the same reason drovr's own escalation watcher has
  DROVR-33 — is bounded by a separate timeout (`MANAGED_ESCALATION_CAPTURE_TIMEOUT_MS`,
  a few seconds): past it, the capture is treated as failed (a distinct
  `WARNING: ... capture timed out after ...` line) and the escalation
  proceeds with no capture path, exactly like an outright error. The
  underlying read/list/write is not cancelled — if it eventually completes
  after losing the race, its file may still land on disk, but that
  resolution is discarded and never changes the journal line or any state
  already committed to. Either way — error or timeout — the escalation is
  observational regardless, so losing the capture must never mean losing
  the alarm.
- **How an operator uses it**: the `[managed-escalation]` journal line
  names the capture's path directly (`... fingerprint: <fp> capture:
  <path>`) whenever a capture was written; read that file to see exactly
  what was on screen at the moment of escalation, instead of relying on the
  journal line's own (necessarily shorter) question/options summary or
  attaching to a pane that may have already moved on. No path in the line
  means either no `captures` dep configured, or the capture errored/timed
  out — check the journal around that same line for a `WARNING:
  [managed-escalation]` line either way.

### Two detectors, one mark

"Two" here means two independent DETECTORS of an escalation-worthy dialog
on a managed-session pane — never two answerers. Drovr's own auto-answering
is never used (see above: its `sendKeys` is permanently a no-op in this
wiring), so there is no answering overlap to worry about, and Butchr's own
`chooseStartupAnswer` (`src/agents/prompt.ts`) is the ONLY thing that ever
presses a key, completely unchanged by this ticket — it still handles
everything it always did (trust, development-channels,
auto-mode-onboarding-shaped dialogs, resume-from-summary, the
settings-warning/settings-recommendation dialogs, Bypass-Permissions), and
drovr's own recognition of a `startup`/`permission` dialog never reaches
Butchr's escalation hook at all (only a genuinely `unknown` one does — see
above).

What DOES coexist is detection: Butchr's own dialog parser
(`src/agents/prompt.ts`) and drovr's (`classifyBlockingScreen`) are
independent implementations that can derive slightly different
fingerprints for the SAME real dialog (different text-extraction). Both
funnel into the same shared core
(`markManagedSessionStalled`/`clearManagedSessionStalled`,
`src/agents/escalation-loop.ts`), keyed by pane id, so whichever detector
sees a dialog FIRST wins the mark; if the other later computes a different
fingerprint for what is really the same episode, it reads as "a new
dialog" and re-logs once more under its own fingerprint. **This is a
known, accepted residual, not a defect**: it can produce one extra
`[managed-escalation]` line for a single real episode, but never a missed
escalation, and `managedSessionEscalations()`'s mark still correctly reads
"stalled" either way.

**How an operator finds and answers a blocked managed session.** Check
`/health`'s `managedSessionEscalations` field, or grep the journal for
`[managed-escalation]` — either names the pane id and the definition's own
path. From there: `herdr agent attach` (via butchr's own live-view web app)
onto the named pane to see the dialog directly, decide the answer, and send
it — butchr's escalation here is deliberately observational, never
answerable through Jira the way a keyed issue's `ANSWER <n> <fingerprint>`
reply is (there is no ticket to reply on). If the SAME definition keeps
re-blocking on the SAME dialog shape, that is exactly the signal to file it
against FACTORY-46 (or whatever succeeds it) for drovr to learn to
recognize.
