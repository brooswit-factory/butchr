# The model-power / effort scale

FACTORY-75 (story FACTORY-74, epic FACTORY-73). Replaces the old 5-point
`tier` scale on managed-session definitions (`docs/managed-sessions.md`)
with TWO independent 0-100 integer axes, applied identically to
rule-launched agents (`Rule.agentPreferences`, `docs/rules.example.json`'s
own schema in `src/rules/rules.ts`) so an operator has one mental model for
"how strong" and "how hard-thinking" an agent should be, everywhere in this
fleet.

Both axes, their tables, and every resolver function live in ONE module:
`src/resources/power-scale.ts`.

## The two axes

- **`modelPower`** (0-100): which MODEL launches, resolved through a
  per-vendor table of ranges -> model alias (`resolveModelPower`).
- **`effort`** (0-100, called `effortPower` on a `Rule.agentPreferences`
  entry — see "Naming" below): how hard that model thinks, resolved through
  ONE shared table of ranges -> `AgentEffort` (`resolveEffortPower`), then
  translated to each vendor's own CLI/config surface at launch time.

Both are validated at load time exactly like every other bad
definition/rule field in this codebase: non-integer or out-of-range is
rejected loudly, never silently clamped (`powerValueProblems`).

### Naming: why not `capability`, and why `effortPower` on a Rule

The ticket's own suggestion for the model axis was `capability`. This
codebase already uses that word for a distinct, unrelated concept
(`src/resources/capabilities.ts`'s per-provider capability declarations —
"does this resource provider support comments/links/whatever"), so reusing
it here would read as related when it isn't. `modelPower` was chosen
instead, and is the field name on BOTH `SessionDefinition` and
`AgentPreference`.

For `AgentPreference` (`Rule.agentPreferences[]`) specifically, the effort
axis is named `effortPower`, not `effort` — that field already exists as an
explicit `AgentEffort` STRING override (`"low"` / `"medium"` / `"high"` /
`"xhigh"` / `"max"`), predating this ticket. Reusing the name for a NUMBER
would be ambiguous, so the two coexist: set `effort` for an explicit
literal, or `effortPower` (0-100) to go through the table — never both on
the same preference entry (rejected at load time, same for
`model`/`modelPower`). `SessionDefinition` has no such pre-existing field,
so its own effort axis is simply named `effort`.

## The model-power tables

Four equal 25-wide bands per vendor, covering 0-100 with no gaps or overlaps
(swept exhaustively in `test/unit/power-scale.test.ts`):

| range | claude | codex |
|---|---|---|
| 0-24 | `haiku` | `gpt-5.6-luna` |
| 25-49 | `sonnet` | `gpt-5.6-terra` |
| 50-74 | `opus` | `gpt-5.6-sol` |
| 75-100 | `fable` | `gpt-6-astra` |

0 = Haiku, 100 = Fable — the operator's own framing (FACTORY-73 [director]
comment, ~18:16Z), ordered by capability/cost. Codex's own table reuses
the SAME 4 models the deprecated `tierToModel` table already named for
tier1-4/5, in the same ascending order, for the same "equally granular"
reason the ticket asked for.

Model strings here are the SAME short aliases `tierToModel` already used
(`"sonnet"`, `"opus"`, ...), not full model ids — `--model sonnet` (Claude)
resolves exactly like a hand-written alias would.

## The effort table (shared across vendors)

One table, five bands, resolving to the SAME `AgentEffort` scale
`--effort` already accepts for Claude:

| range | effort |
|---|---|
| 0-19 | `low` |
| 20-39 | `medium` |
| 40-59 | `high` |
| 60-79 | `xhigh` |
| 80-100 | `max` |

### Per-vendor emission

- **Claude**: `--effort <value>` — the resolved `AgentEffort` string
  reaches the CLI flag directly (`claude --help`, version 2.1.251, confirmed
  in this checkout's own environment: `--effort <level>` accepts exactly
  `low, medium, high, xhigh, max`).
- **Codex**: no CLI flag exists (`codex --help`, version 0.145.0, has no
  top-level effort/reasoning option). Codex's own config surface exposes a
  `model_reasoning_effort` key instead — **LIVE-VERIFIED** in this
  checkout's own environment (`codex-cli` 0.145.0, model `gpt-5.6-sol`,
  2026-09-26), not just inferred from binary strings: running `codex exec`
  with an intentionally-wrong value (`model_reasoning_effort = "minimal"`,
  OpenAI's public GPT-5-class naming, which an earlier draft of this ticket
  assumed) returned a real API error naming the ACTUAL accepted set
  verbatim —

  > `Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol'
  > model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh',
  > and 'max'.`

  — six values, five of which (`low`/`medium`/`high`/`xhigh`/`max`) are
  spelled IDENTICALLY to `AgentEffort`. `codexReasoningEffortFlag` is
  therefore a plain passthrough, no clamp, no translation (an earlier
  version of this function assumed the narrower public naming and clamped
  `xhigh`/`max` down to `high` — corrected once the live value above came
  back). Confirmed the value is not merely ACCEPTED but ACTUALLY ENGAGED:
  the same hard reasoning prompt ("find the smallest n where n²+n+41 isn't
  prime") run once with `model_reasoning_effort = "none"` reported
  `reasoning_output_tokens: 0` in codex's own `turn.completed` usage event,
  and once with `"max"` reported `reasoning_output_tokens: 60` — both
  landed on the correct answer (40), so effort visibly changed HOW the
  model got there, not just whether the config key was accepted.

  Drovr's own `CodexAgentLaunch` type (`@brooswit/drovr`) has NO effort
  field at all — extending it is out of scope for this ticket (a separate,
  independently-released package). Instead, `model_reasoning_effort` is
  written into the SAME per-workspace `.codex/config.toml` file
  `buildWorkspace` already writes `approval_policy`/`sandbox_mode` into for
  a `jira-project` ("freeform") Codex agent — see `src/agents/workspace.ts`.
  Not yet verified: whether this exact accepted-value set holds for EVERY
  Codex model this daemon might configure (only `gpt-5.6-sol` was checked
  live) — the codex tables in this module (`gpt-5.6-luna`/`-terra`/`-sol`,
  `gpt-6-astra`) are from the SAME model family the check ran against, so
  this is a reasonable extrapolation, not a second guess, but a model swap
  is worth re-checking.

## Auto-reconcile on change — exactly one restart, never a loop

If a definition/rule's value on EITHER axis changes (an edit, or a table
edit shipped in a new daemon build) so that it now resolves to a different
model OR effort than the running agent's, the daemon stops the agent and
normal reconcile starts it again with the new model/effort — exactly once,
never a respawn loop. This is the SAME lesson FACTORY-43 already fixed for
`permissionMode`/`strictMcpConfig` (`docs/managed-sessions.md`'s own
history, PR #447 on `brooswit-factory/butchr`): the launch argv builder and
the stale-check must derive from the SAME resolver, and the resolved
`(model, effort)` pair a workspace was actually spawned with is persisted at
`buildWorkspace()` time (`.butchr-model.json`/`.butchr-effort.json`,
mirroring `.butchr-permission-mode.json`).

The comparison itself is NEW, not an extension of FACTORY-43's
`checkArgv`/`checkManagedAgentArgv` (`@brooswit/drovr`) — that function
deliberately never compares `--model`/`--effort` at all (see
`HerdrHerd.staleIssues()`'s own top comment in `src/agents/herd.ts`), so
this ticket added its own: `resolvedAgentOf` (a new, optional
`HerdrHerd` constructor seam) answers "what does this issue's definition/
rule CURRENTLY resolve to, right now" — for a managed session, from
`ManagedSessionResourceDeps.resolvedAgents` (a map rebuilt every poll from
that poll's eligible definitions, the same shape `roles`/`accountPolicies`
already use); for a rule-launched agent, from that rule's own
`agentPreferences` entry (already resolved once, at `loadRules()` time —
see "Rules support" below). `staleIssues()` compares that LIVE value
against the PERSISTED one; a mismatch is flagged stale.

### What happens to already-running agents at deploy

**Nothing** — this was a real gap the first review of PR #473 caught and it
is worth stating explicitly, since it is easy to read the paragraphs above
as "matched state is never flagged" without noticing the edge case: a
workspace spawned by a build *before* this ticket never wrote
`.butchr-model.json`/`.butchr-effort.json` at all (those files did not
exist yet). Comparing that absence directly against the live resolution
(always defined for a `tier`-based definition, or for a rule that already
sets an explicit `model`/`effort`) would flag EVERY already-running agent
stale on the very first poll after deploy — a fleet-wide mass restart, the
exact "unexpected behaviour change on deploy" this ticket's own back-compat
requirement forbids.

Fixed in `staleIssues()` (`src/agents/herd.ts`) by falling back to reading
what the process was actually launched with straight from its own
`proc.argv` whenever the persisted file is absent: Claude always emits both
`--model` and `--effort` unconditionally (`agentLaunchConfig`'s claude
branch resolves both through a non-optional default), so this recovers the
real value with no `buildWorkspace` change needed to read back a *previous*
build's launch. Codex has no `--effort` flag at all (its reasoning effort
lives only in `.codex/config.toml`, never argv) and emits `--model` only
when one was explicitly set; with no persisted file and no argv signal for
Codex effort, there is nothing to compare against, so that specific
comparison is skipped (treated as "unknown, not stale") rather than
guessing. The net effect: an already-running agent that already matches
its definition/rule is NOT flagged at deploy; one whose definition/rule
has genuinely changed since it was spawned IS flagged, exactly once, and
the respawn that follows persists real values so every later poll goes
back to the ordinary persisted-vs-live comparison. Regression tests for
both directions, for both managed sessions and rule agents, live in
`test/unit/herd.test.ts` under "FACTORY-75 review fix: legacy workspaces".

A naive implementation that skips the persist-and-read-back step — e.g.
comparing the live resolution against itself, or against nothing at all —
would either flag every agent stale on every poll (FACTORY-43's own
respawn-loop failure shape) or never catch a real drift at all. Both
failure shapes have their own dedicated regression test in
`test/unit/herd.test.ts` (search for `FACTORY-75`), mirroring FACTORY-43's
positive/negative pair pattern exactly.

## Back-compat: the deprecated `tier` field

Existing `tier1`..`tier5` managed-session definitions (the 8 live codey
ones at the time of this ticket) keep loading, unchanged. Critically, a
`tier`-based definition **bypasses the modelPower/effort tables entirely**
— `effectiveAgent()` (`src/resources/session-definition.ts`) bypasses
`resolveModelPower`/`resolveEffortPower` for this path and calls the
pre-existing `tierToModel(vendor, tier)` directly, returning NO `effort` key
at all. This is deliberate, not an oversight: it's the only way to
reproduce today's launch behaviour byte-for-byte on BOTH vendors —

- **Claude** already ALWAYS sends `--effort` today (`ClaudeAgentLaunch.effort`
  is a REQUIRED field in `@brooswit/drovr`) — for a managed session, that
  defaults through `agentLaunchConfig`'s own
  `agent.effort ?? effortFor(spec.issuetype)` fallback chain
  (`src/agents/argv.ts`/`workspace.ts`) to `"high"` (issuetype
  `"managed-session"` isn't in `effortFor`'s map). Leaving `effort` unset in
  `effectiveAgent()`'s tier path preserves that fallback chain exactly,
  INCLUDING honouring any global `config.agent.effort` override a daemon
  might have configured — hardcoding `"high"` here instead would silently
  override that.
- **Codex** sends NO reasoning-effort override at all today for a managed
  session (no `.codex/config.toml` `model_reasoning_effort` line is ever
  written outside the `jira-project` freeform path). Resolving `tier`
  through the effort table would always produce SOME value and start
  emitting a flag that has never been sent before — a real behaviour
  change this ticket's own back-compat requirement forbids.

A `tier`-based definition is still ELIGIBLE (never invalid, never excluded)
but is logged once per path via `onceDeprecatedTier` — migrate to
`modelPower`/`effort` when convenient; migrating existing definitions is
NOT this ticket's job (admin-assembly does it later, as an explicit,
separate, post-deploy config change).

A definition sets EITHER `tier` alone OR both `modelPower` and `effort`,
never a mix (`sessionDefinitionProblems`) — see `docs/managed-sessions.md`'s
field table.

## Rules support

The same two axes apply to rule-launched agents: `AgentPreference` gains
`modelPower`/`effortPower` (see "Naming" above), resolved to plain
`model`/`effort` at `loadRules()` time (`src/rules/rules.ts`) — by the time
ANY of this codebase's existing `agentPreferences`-consuming code (every
`specFor*` in `src/rules/*-type.ts`, `HerdrHerd`'s own `prepare()`) looks at
a preference, `model`/`effort` are already resolved exactly as if written by
hand. Nothing downstream of `loadRules()` needed to change. Back-compat is
trivial here (unlike the managed-session `tier` case): no rule ever set
`modelPower`/`effortPower` before this ticket, so every existing rule is
byte-for-byte unaffected.

`modelPower`/`effortPower` are rejected for harness `"agy"` — no power
table exists for it (Drovr's own `AgyAgentLaunch` has no effort concept at
all).

## The four operator-requested canonical target pairs

Documented here so admin-assembly has ONE place to read them from — none of
these are applied to anything live by this ticket; they are POST-DEPLOY
config changes admin-assembly makes later, outside this ticket's scope.

| target | `modelPower` | `effort` | resolves to |
|---|---|---|---|
| admin-agentcost / admin-agentvelocity (managed sessions, codey/zippy) | `100` | `70` | **Fable, `xhigh` effort** (sub-max — `100`/`max` is reserved for the true ceiling) |
| Every other managed session (directors/admins, codey and zippy) — the canonical "Sonnet/medium" pair | `25` (`CANONICAL_SONNET_MODEL_POWER`) | `20` (`CANONICAL_MEDIUM_EFFORT`) | **Sonnet, `medium` effort** |
| Servy Epic/Bug jira-work agents (rules) | `75` | `90` | **Fable, `max` effort** |
| Servy task-level jira-work agents (Story/Task/Sub-task workers, rules) | `25` (the same canonical Sonnet value) | `90` | **Sonnet, `max` effort** |

`CANONICAL_SONNET_MODEL_POWER`/`CANONICAL_MEDIUM_EFFORT` are mine to pick
(the operator asked for ONE documented number, not a specific value) — I
chose the START of each band, so the pair reads as the obvious canonical
point rather than an arbitrary mid-band number.

## Visibility

`effectiveAgent()` (session definitions) is the one exported resolver
everything reads from — never a second, independently-recomputed copy.
`specForSessionDefinition`/`parsePreferences` both call it (or its rules
equivalent) directly, and the resolved `spec.agents` entry rides on the
`[spawn]` journal line (`HerdrHerd.spawn`'s own `SPAWN_TAG` success log,
`src/agents/herd.ts`) for every spawn, managed session or rule-launched
alike. No dashboard/UI work is part of this ticket (FACTORY-68 owns that
surface) — this is deliberately just "not buried in the launch path", per
the ticket's own visibility requirement.
