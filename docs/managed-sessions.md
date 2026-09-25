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
  "frozen": false
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

A bad manifest (invalid JSON, an unknown field, a wrong-type/out-of-range
value) is rejected with every problem named, collected in one pass, same
style as `filesystem`'s own query validation:

```
/home/butchr/.config/butchr/session-definitions/foo.json: rules[0].vendor must be one of claude, codex
```

### `mcpServers`/`channels`: deferred to S4

The ticket's own required field — "MCP server list, with per-MCP
notification flags; channel bindings to ANY MCP channel server" — is
**deliberately not built by this ticket**. S4 (BUTCHR-395, task BUTCHR-411)
is adding `Rule.mcpServers` (`McpServerBinding[]`: `name`, `type: "http"`,
`url`, `headersEnvVar`, `channel: boolean`) on branch `BUTCHR-395` — not yet
on `main` or `BUTCHR-393` as of this ticket. Per BUTCHR-408's own sequencing
instruction: do not copy or re-declare `McpServerBinding`, and do not merge
that branch in. A manifest naming either `mcpServers` or `channels` gets a
specific, actionable validation error rather than a generic "unknown
field" one or silent acceptance — see `sessionDefinitionProblems` in
`src/resources/session-definition.ts`. Once S4 lands and the sequencing
decision is made, this section gets the real field.

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

## Per-vendor launch differences

`permissionMode` reaches a **Claude** launch's `ClaudeAgentLaunch.permissionMode`
verbatim (Drovr; untyped string there, validated at OUR layer via
`SESSION_PERMISSION_MODES` before it ever reaches launch, so a typo fails at
manifest-load time, not at spawn time). **Codex** has no `permissionMode`
concept in `CodexAgentLaunch` (its own `trustWorkspace`/
`bypassApprovalsAndSandbox` fields instead) — a `vendor: "codex"`
definition's `permissionMode` is validated and stored like any other, but
is simply not forwarded to a Codex launch. Building Codex-specific
permission wiring is out of scope for this ticket.

## Not in this version

- **`mcpServers`/channel bindings** — deferred to S4 (BUTCHR-395/BUTCHR-411);
  see "`mcpServers`/`channels`: deferred to S4" above.
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
  managed-session definitions) and **S4's own channel delivery** — both
  explicitly out of scope per the ticket.
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
