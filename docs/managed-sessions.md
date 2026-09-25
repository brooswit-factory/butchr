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
missing directory is zero definitions, nothing staffed, no error — same
"absent means empty, not broken" discipline as a missing default
`rules.json`.

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
| `workingDirectory` | yes | Where the managed agent actually works. Absolute, or `~`/`~/rest` (expanded against the daemon's own `$HOME`, same rule as a `filesystem` query's `root`). Becomes the spawned agent's REAL process `cwd` — see "Working directory wiring" below. |
| `brief` | yes | The agent's prompt/role. Literal text; no `@builtin:` shorthand (that convenience is a `Rule` field's, not a definition's). |
| `vendor` | yes | `"claude"` or `"codex"` — narrower than `Rule.agentPreferences[].harness` (`agy` is not a Bakr/Candlestix vendor). |
| `tier` | yes | `"tier0"` \| `"tier1"` \| `"tier2"`, mapped to a concrete model by `tierToModel()` — see "Tier -> model mapping" below. |
| `permissionMode` | yes | `"default"` \| `"acceptEdits"` \| `"bypassPermissions"` \| `"plan"` \| `"auto"`. Reaches a Claude launch's `permissionMode` verbatim (see "Per-vendor launch differences"). |
| `execution` | no | Reuses `Rule`'s `ExecutionMode` type/validation VERBATIM (`"swarm"` default). Stored, surfaced — NOT acted on by this ticket; see "Not in this version". |
| `account` | no | Reuses `Rule`'s `AccountPolicy` type/validation verbatim (`"none"` default). Stored only — the Rocket.Chat account lifecycle itself is unimplemented for every provider today, managed sessions included. |
| `role` | no | Reuses `Rule`'s `AgentRole` type/validation verbatim (`"worker"` default, `"sentinel"` for fleet-cap-exempt agents — e.g. Candlestix directors, MUD players). Stored, validated — NOT yet read by the fleet-cap admission classifier; see "Not in this version". |
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

**PROVISIONAL.** The ticket points at a preserved Candlestix branch
(`preserve/candlestix-runtime-f198ae1/`, in "the CNDLX manager workspace")
as the source of truth, falling back to "read the candlestix repo under
`~/code` and ask_boss for the location" if unreachable. Both were searched
exhaustively (2026-09-25, BUTCHR-408): no path or git ref anywhere on the
build host matches `preserve/candlestix-runtime-f198ae1` or `f198ae1`
at all, and `~/code/brooswit-factory/candlestix` carries no tier/model
mapping in any branch, tag, or even unreachable/dangling git object. Asked
of the boss on BUTCHR-408 2026-09-25; unanswered as of this doc.

Until the real table arrives, `tierToModel()` (`src/resources/session-definition.ts`)
uses:

| tier | model | confidence |
|---|---|---|
| `tier0` | `haiku` | provisional — follows `modelFor`'s own cheap/default/expensive shape (`src/agents/workspace.ts`), not independently confirmed |
| `tier1` | `sonnet` | **confirmed** — BUTCHR-393's own ticket text: "10 MUD players: Claude at tier 1 (sonnet)" |
| `tier2` | `opus` | provisional, same shape as `tier0` |

`tierToModel` is the ONE place this mapping lives; update it (and
`SESSION_TIERS` if the tier names themselves turn out different) once the
real table is known — nothing else in this codebase encodes tier names.

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

`SpawnSpec.cwd` (`src/agents/workspace.ts`, BUTCHR-408) is the one new seam
in the shared spawn machinery: when set, `buildWorkspace` writes the
bookkeeping files (CLAUDE.md/AGENTS.md/brief.md/mcp.json/ENVIRONMENT.md)
directly into THAT directory instead of the synthetic
`<workspace root>/filesystem/managed-sessions/<encoded-path>` tree every
other filesystem resource gets, and `agentLaunchConfig` launches the agent
with that same directory as its real process `cwd`. This is necessary,
not cosmetic: a Bakr agent's whole point is working IN its own project
directory, and Claude/Codex read their own CLAUDE.md/AGENTS.md from their
own `cwd` at startup — writing bookkeeping into a directory the agent never
looks at would mean it never sees its own brief.

**Tradeoff, documented rather than solved by this ticket**:
`agentIdOfWorkspacePath`'s reverse mapping (a pane's `cwd` -> its agent id)
assumes the fixed `workspaceDirFor` layout, so it does not recognise a
`cwd`-overridden managed-session agent's pane by path. PRIMARY
reconciliation (spawn/stop, no-double-owner) is unaffected — it keys purely
off `herd.runningIssues()`'s own agent-key labels, never a cwd reverse
lookup — but secondary safety nets that DO use that reverse mapping
(`missingRulesPreflight`'s live-rule-agent check, stranded-workspace/
session-limit pane recovery) do not cover a managed-session agent's pane.
Every EXISTING caller omits `spec.cwd`, so this is purely additive —
nothing about any other provider's behaviour changes.

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
- **The real Candlestix tier -> model table** — provisional; see "Tier ->
  model mapping" above.
- **A managed-session agent's own `role` is not read by the fleet-capacity
  admission classifier.** `roleOfAgent` (`src/daemon/index.ts`) resolves a
  role from a `Rule`, and the built-in managed-sessions rule is ONE shared
  `Rule` for every heterogeneous definition file — a per-DEFINITION role
  needs a different hook than the rule-level classifier BUTCHR-398 built.
  Every managed-session agent is classified `"worker"` today, same as an
  unflagged rule's agents always were before BUTCHR-398. `role` is still
  fully validated and stored on the manifest (default `"worker"`,
  `"sentinel"` accepted) — wiring it into the fleet cap is a natural
  follow-up once there is a clean per-resource role hook, not something
  this ticket patches around with module-level mutable state.
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
