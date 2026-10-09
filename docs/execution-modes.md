# `execution`, `account`, `role`: rule schema, query-level identity, reconciliation, and fleet capacity

BUTCHR-397 (task 1) and BUTCHR-398 (task 2), both of story BUTCHR-392, epic
BUTCHR-391 (the Bakr/Candlestix consolidation). BUTCHR-397 shipped the
`execution`/`account` rule fields, their validation, and the identity codec
for the one agent a `singleton`/`persistent` rule runs. **BUTCHR-398 ships
reconciliation** — actually spawning, stopping, and delivering scope-wide
events to that agent, for all four resource providers — plus a new field,
`role`, added mid-story by an epic-level decision (see "Fleet capacity role"
below). Nothing on this page changes today's `swarm` behaviour, which stays
the default for both `execution` and (with `role`) the default for capacity.

## The three fields

All optional on a `Rule`; a pre-BUTCHR-397 rules document loads unchanged,
with all three fields filled in at their defaults — no migration, no changed
agent keys, no changed admission behaviour.

| field | values | default | independent of the others? |
|---|---|---|---|
| `execution` | `swarm` \| `singleton` \| `persistent` | `swarm` | yes |
| `account` | `none` \| `temporary` \| `permanent` | `none` | yes |
| `role` | `worker` \| `sentinel` | `worker` | yes |

Any combination across all three is valid at the schema level. A bad value is
rejected at load with the rule's index and field named, e.g.:

```
rules[2].execution must be one of swarm, singleton, persistent
rules[2].role must be one of worker, sentinel
```

**Provider scope.** All three fields are accepted for every resource
provider (`jira-work`, `github-issue`, `jira-idea`, `zendesk-ticket`,
`jira-project`, and — BUTCHR-407 — `filesystem`) — though `jira-project`'s
own capacity role is always `"sentinel"` regardless of what `role` says; see
that field's own note below.

## What `execution` means

- **`swarm`** (today's only behaviour before this story, and the default):
  one agent per matching resource, and none when nothing matches. Unchanged
  by this story in every respect — same keys (`encodeAgentKey`), same
  workspace layout, same reconciliation, same event routing.
- **`singleton`**: one agent for the rule's WHOLE matching workload, not one
  per ticket. It stops when the query returns zero matches, and starts again
  when matches return. **Implemented (BUTCHR-398).**
- **`persistent`**: one agent even at zero matches. Only an explicit freeze
  (`enabled: false`) stops it — a query dropping to zero matches does not.
  **Implemented (BUTCHR-398).**

## What `account` means

Rocket.Chat account lifecycle for a rule's agent(s), independent of
`execution`: `none` (nothing — today's behaviour, exactly), `temporary`, or
`permanent`. **The lifecycle module exists (BUTCHR-410, S4):** an RC REST
client and an idempotent, race-safe account manager
(`src/resources/rocketchat.ts`, `src/accounts/manager.ts`,
`src/accounts/identity.ts`) implementing create-if-missing, unprovision, and
a configurable guardrail below RC's 50-user allowance. **Wired into agent
start/stop (BUTCHR-412, S4 follow-up):** `src/agents/account-lifecycle.ts`
calls `ensureAccount`/`releaseAccount` from `reconcileNow`
(`src/daemon/loop.ts`) at exactly the ids about to be spawned/stopped, for
every rule loop and every execution mode alike — `execution` and `account`
are genuinely independent axes; the account layer never inspects which
execution mode produced an id. See `docs/rocketchat-accounts.md`'s "Wiring"
section for the full design: which stop paths release a temporary account
and which don't (respawn, daemon-restart and a session-limit close never
do), and what happens when either cap (the RC-wide guardrail, or the
separate temporary-account cap) refuses (the spawn is withheld, not
degraded).

**Corrected credential design (BUTCHR-412, BUTCHR-391 comment 24007): an
agent never holds a Rocket.Chat credential.** Butchr mints and stores the
account's token itself (a 0600 file, never inside any agent's workspace) and
hands Nexus a batched manifest of (account name, token file path) pairs;
Nexus registers each account with rocketr, the central bridge that actually
holds every token. An agent's own MCP binding to rocketr names only its
account, non-secret, in a header (`x-rocketr-account` by convention) — see
`McpServerBinding.accountHeader` below and `docs/rocketchat-accounts.md`'s
"Credential design, corrected" section for the full mechanism.

**`account` is not a prerequisite for event-driven delivery.** A rule's
`mcpServers` bindings (BUTCHR-411, see docs/mcp-server-bindings.md) bind
Claude to push notifications from ANY MCP channel server, independent of
`account` — an `account: "none"` rule (e.g. Candlestix's MUD players, who
get no Rocket.Chat account at all under S4) still gets full, non-polling
channel delivery from its own bound server(s). The two fields share a rule
but nothing else: `mcpServers`-derived launch argv never reads `account`.

## `mcpServers`: binding a rule to additional MCP servers (BUTCHR-411)

Separate from the three fields above — see docs/mcp-server-bindings.md for
the full field, launch-argv, and staleness story. Noted here only because a
reader of this page's `account` section is likely to ask exactly the
question the previous paragraph answers.

## `permissionMode` and `lizardMode`: rule-side lizard mode (FACTORY-87/FACTORY-76, companion to DROVR-42)

Two independently optional fields, same house style as `execution`/`account`/
`role` above (accepted for every resource provider, independent of each
other and of every other field):

| field | values | default | reaches argv? |
|---|---|---|---|
| `permissionMode` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` \| `auto` | absent → butchr's own default applies (`DEFAULT_PERMISSION_MODE`, `acceptEdits`, src/agents/argv.ts), for every provider including `jira-project` since FACTORY-129 | yes — `SpawnSpec.permissionMode` |
| `lizardMode` | boolean | absent → eligible (`ruleLizardModeOf`: `rule.lizardMode !== false`); explicit `false` → never scanned | no — daemon-side only |

**Rollout, and there is no global override.** `permissionMode` reaches
launch argv, so every currently-running agent with no explicit
`permissionMode` was respawned ONCE, fleet-wide, at the deploy that shipped
this default (FACTORY-138) — a value change caught by the existing
stale-argv check, not a loop; `jira-project` agents got their own separate
one-time respawn at the later FACTORY-129 deploy that removed their
`"auto"` override. An agent with an explicit `permissionMode`
(`bypassPermissions` included) and a Codex/agy agent are not respawned by
either change. `lizardMode` never reaches argv, so flipping it (or its
default changing, as it did here) takes effect on the very next
permission-answer tick with no respawn. There is no config file or env var
that turns this default off fleet-wide; rolling one rule back means setting
`permissionMode: "bypassPermissions"` explicitly on it (which respawns that
rule's agents once) — "leave it unset" now means `acceptEdits`, not the
pre-FACTORY-138 behaviour.

**What they do.** `lizardMode: true` is the operator's own name (FACTORY-67)
for turning on the daemon's standalone permission-answer timer
(`src/agents/permission-answer-loop.ts`, see `docs/permission-answer-loop.md`
for exactly which option it presses and how that is logged — deliberately
not restated here, since it is drovr's own answering policy, not this
field's concern) for every agent this rule launches: it answers an
unambiguous tool-permission dialog so that agent never sits frozen on that
one dialog for hours. It is a separate toggle from `permissionMode`, not
tied to one value of it — it pairs with any `permissionMode` that still
prompts before a tool call (`"default"` included, but not only that one),
so the paired mode's own safety holds for every OTHER prompt it still
shows. Either field may be set without the other — they are independent.
DROVR-42 shipped the identical pair of concepts (`SessionDefinition.permissionMode`/
`.lizardMode`) for managed-session definitions first; this is the rule-side
extension, reusing the SAME daemon timer rather than a second one.

**`permissionMode` reaches argv; it needed no new plumbing.** Every
`specFor*` builder (`specForMatch`/`specForRuleQuery`, `specForProject`,
`specForGithubIssue*`, `specForGithubPr*`, `specForFilesystem*`) forwards
`rule.permissionMode` onto its `SpawnSpec.permissionMode` when set. The
persist-at-spawn/read-back stale-argv pair FACTORY-43 built for this field
(`buildWorkspace()`'s `.butchr-permission-mode.json`, read back by
`HerdrHerd.staleIssues()`) was never managed-session-specific — it already
operates on `spec.permissionMode` for any spawn, so a rule-launched agent's
`permissionMode` gets the same stale-argv safety with zero changes to that
layer. Absent means today's behaviour exactly, for every provider, `jira-project`
included (FACTORY-129): a jira-project agent with no explicit `permissionMode`
now gets butchr's ordinary default (`DEFAULT_PERMISSION_MODE`,
`agentLaunchConfig`, src/agents/argv.ts) exactly like every other rule kind —
the jira-project-only `"auto"` override this paragraph used to describe is
gone. Safety for that change comes from lizard-mode eligibility, not a
special-cased permission mode; see the next section.

**`lizardMode` never reaches argv — same design as `SessionDefinition.lizardMode`,
and mostly plumbing to reuse.** It is resolved live, not persisted: the
permission-answer timer's `eligiblePanes` hook (`lizardModeLabel` in
`src/daemon/index.ts`) already resolved a managed-session pane's opt-in from a
live map; `ruleLizardModeOf`/`lizardModeLabelFor` (exported, pure functions in
`src/agents/permission-answer-loop.ts` — `src/daemon/index.ts` just binds them
to its own live state) extend the SAME hook to every OTHER rule-engine agent
id by looking its owning `Rule` up in the already-loaded `rules` list (no live
poll needed — unlike a managed-session definition, which is its own file
discovered fresh every poll, a rule's `lizardMode` is fixed for the daemon's
process lifetime, the same as every other `Rule` field) and reading
`Rule.lizardMode` straight off it — the same "rule-level fallback" shape
`ruleRoleOfAgent` already uses for `role`. No second timer, no second prompt
parser: dialog recognition stays drovr's job (FACTORY-49) end to end.

**No Codex-vendor rejection, unlike `SessionDefinition`'s fields.** A managed
session has one fixed `vendor`, known at manifest-load time, so DROVR-42 could
hard-reject `lizardMode: true`/an explicit `permissionMode` for `vendor:
"codex"` outright. A `Rule` has no such fixed vendor — `agentPreferences` is a
ranked FALLBACK list (see "The vendor selector" below), and which harness an
individual launch actually gets is a runtime decision no validator here can
see. Both fields are therefore accepted unconditionally at the schema level;
FACTORY-577: for a launch that lands on Codex, `permissionMode` now IS
forwarded (`agentLaunchConfig`'s Codex branch maps it onto
`bypassApprovalsAndSandbox`, same as `SessionDefinition.permissionMode` —
see docs/managed-sessions.md's "Per-vendor launch differences") — only an
Agy-resolved launch still silently drops it (that branch never reads
`permissionMode` at all). `lizardMode` is still silently inert for Codex
only when `permissionMode` is itself absent from that spec (drovr's own
Codex approval-answering has nothing to answer once the bypass flag is
dropped) and inert outright for Agy (drovr's Claude-specific dialog
recognition never matches a non-Claude pane) — never a validation error
either way.

**Absent means unchanged, verified.** A rules document that sets neither
field loads and behaves byte-for-byte as before this ticket — no new key on
any parsed `Rule`, no new `SpawnSpec` field on any `specFor*` output, no
change to which panes the permission-answer timer scans.

### Canary: narrowing `eligiblePanes` to one pane (FACTORY-581 SAFETY GUARD 4)

`@brooswit/drovr` >= 0.16.8 (FACTORY-580/586/587) adds a new no-separator
file-edit/create recognition sibling to `autoAnswerPermissions` — a new
AUTO-ANSWER PATH the permission-answer timer presses keys through, same as
every pre-existing matcher. Per FACTORY-460's diagnosis finding (d) and
FACTORY-581's own instruction, there is **no new feature flag** for this: it
rides the EXISTING `PermissionAnswerLoopDeps.eligiblePanes` gate
(`src/agents/permission-answer-loop.ts`'s own documented single enforcement
point — "a pane left out of that map is never scanned or answered AT ALL"),
narrowed by one optional config value, `Config.permissionAnswerCanaryPaneLabel`
(`BUTCHR_PERMISSION_ANSWER_CANARY_PANE`, trimmed; unset/blank is the default
and means fleet-wide, unchanged).

**What it does.** When set, `permissionAnswerEligiblePanes` in
`src/daemon/index.ts` drops every pane whose `lizardModeLabel` does not
EXACTLY equal this value — `lizardModeLabel` itself (and therefore
`permissionMode`/`lizardMode` resolution above) is computed first and
completely unchanged; the canary value only filters its OUTPUT. A pane whose
label doesn't match is excluded from the eligible map exactly as if
`lizardMode: false` had been set on it for this tick — never scanned, never
answered, by the same construction `lizardMode: false` already uses.

**Grain: per-pane, not per-dialog-type.** `eligiblePanes` has no concept of
WHICH dialog a pane might show, only whether the pane is scanned at all —
there is no way to carve "only the new file-edit fallback" out of a blanket
pane gate without a second, dialog-type-aware flag, which is exactly what
FACTORY-581 forbids inventing. So this canaries drovr 0.16.8 as a WHOLE (the
new fallback plus every pre-existing matcher) on one named pane, the same
coarse grain `lizardMode` itself already operates at — not a file-edit-only
canary.

**ONE-STEP ROLLBACK and widen.** Unset `BUTCHR_PERMISSION_ANSWER_CANARY_PANE`
(or set it empty) and restart the daemon: every other pane's eligibility
reverts to exactly what `lizardModeLabel` alone would produce, with nothing
else to undo. Widening to fleet-wide after a successful canary window is the
SAME one step, in the same direction.

**Attribution during the canary.** Read `docs/managed-sessions.md`'s
"Resolution, with a DISTINCT, ATTRIBUTABLE tag per clearing path" — a
managed-session canary pane's cleared dialogs show up tagged
`no longer blocked (answered: recognizedVia=no-separator-file-edit)`
specifically for the new fallback, composing with drovr's own JSONL audit
(`grep '"recognizedVia":"no-separator-file-edit"' <auditPath>`,
`docs/permission-approval.md` GUARD 3/7 in `@brooswit/drovr`) rather than
requiring a second, separate signal.

**Absent means unchanged, verified** — same discipline as the rest of this
section: a daemon started with no `BUTCHR_PERMISSION_ANSWER_CANARY_PANE`
behaves byte-for-byte as before this field existed.

## The vendor selector: already there, not duplicated

`agentPreferences[].harness` (`"claude" | "codex" | "agy"`, `src/rules/rules.ts`)
is the per-definition agent vendor/provider selector — a rule's ranked
`agentPreferences` picks which harness runs its agent(s), for every provider,
swarm or query-level alike. See `agent-providers.md`/`agent-model.md` for the
full harness-selection story; not repeated here.

## Query-level agent identity

`swarm`'s identity is per-resource: `encodeAgentKey({resourceProvider, ruleId,
resourceId})` → `<provider>:<ruleId>:<resourceId>` (see `src/rules/agent-key.ts`).
That has no representation for "the one agent a `singleton`/`persistent` rule
runs" — there is no resource to name, and matched resources come and go
across polls while the ONE agent must not.

### The codec

```
encodeQueryAgentKey({ resourceProvider, ruleId })
  → <resourceProvider>:<ruleId>:%40query      e.g. jira-work:triage:%40query
  (the `@` is percent-escaped in the real, produced key — see encodeQueryAgentKey's own doc comment, src/rules/agent-key.ts)
```

- **Derived from provider + rule id ALONE, never a matched resource.** The
  same rule always produces the same key, on every poll and across every
  daemon restart — this is what lets reconciliation (BUTCHR-398) maintain
  exactly 0 or 1 owners for that rule instead of risking duplicates.
- **Same encoding discipline as `encodeAgentKey`**: each component
  percent-escaped (`encodeURIComponent`), and `decodeQueryAgentKey` requires
  canonical re-encoding — so, as with the per-resource codec, no two distinct
  strings decode to the same tuple.
- **Cannot collide with, or be mistaken for, a per-resource key of ANY
  provider.** The literal `@query` marker (percent-escaped to `%40query` in the
  real key — see the codec above) in the resource-id slot can never be a
  real resource id (proven, not assumed — see `test/unit/rules.test.ts`).
  `decodeAnyAgentKey(key)` decodes either shape, tagged `{ kind: "resource",
  ... }` or `{ kind: "query", ... }`, for code that must handle both.

### Workspace layout: a sibling, never a parent

A per-resource workspace lives at `<root>/<provider>/<ruleId>/<resourceId>`
(`workspaceDirFor`, `src/agents/workspace.ts`). A query-level workspace lives
at `<root>/<provider>/<ruleId>/%40query` — the same depth, a SIBLING inside
that rule's own directory:

```
<root>/jira-work/triage/BUTCHR-12/      ← a per-resource agent (swarm)
<root>/jira-work/triage/BUTCHR-31/      ← another one
<root>/jira-work/triage/%40query/       ← the ONE singleton/persistent agent for this rule
```

## Reconciliation (BUTCHR-398)

Every provider's `ResourceType.discovery.search()` groups that poll's flat
per-resource matches (`search*Rules` — unchanged, still produces one match
per (enabled rule, matched resource), for EVERY execution mode) into this
poll's PRIMARY items via one shared, provider-neutral function,
`groupExecutionUnits` (`src/rules/execution.ts`):

- **`swarm`**: each match becomes its own `"resource"`-kind unit — a pure
  relabelling of exactly today's matches, so this is byte-for-byte unchanged.
- **`singleton`**: one `"query"`-kind unit (`encodeQueryAgentKey`) when the
  rule has one or more matches this poll, none when it has zero.
- **`persistent`**: one `"query"`-kind unit always, even at zero matches. A
  disabled rule (the freeze/off path) is excluded from `allEnabledRules`
  before this function ever sees it, so it produces no unit at all the
  moment it is disabled — the same mechanism that already makes any other
  rule's agents disappear.

Because a `"query"` unit is a single, stable, poll-independent id, the
GENERIC reconciler (`planReconcile`, `src/reconcile/plan.ts`, unchanged) does
the rest for free: `spawn = desired − running` and `stop = running − desired`
already guarantee exactly 0-or-1/1 owners, restart adoption (an existing
running query-level agent is already in `running`, so it's never re-added to
`spawn`), and no duplicates — with zero new code in the reconciler itself.

**Poll-failure discipline.** `search*Rules` rejects the WHOLE poll on any one
rule's failed search (unchanged, pre-existing) — a partial/failed read never
reaches `groupExecutionUnits` at all, so it can never be misread as "zero
matches" and stop or spawn anything. Same partial-result discipline every
provider's swarm mode already has.

**Mode switches are LOUD, never silent.** `logExecutionModeSwitches`
(`src/rules/execution.ts`) is called once per poll, per provider, with that
provider's own currently-RUNNING ids: a per-resource id whose rule now reads
non-swarm, or a query-level id whose rule now reads swarm, logs a
`WARNING: [execution-mode] ...` line naming the rule, the old and new mode,
and what's about to happen (the old-shape agent is stopped this poll, not
respawned; the new-shape agent spawns in its place) — BUTCHR-370-class
rename-safety: never a silent retirement or duplication. Purely observational
(same "observe and speak, never gate" contract as `checkCrashLoop`); it
changes nothing about the actual plan.

## Event delivery to a query-level agent (BUTCHR-398)

A query-level agent has no single resource to diff, so it is never a
PRIMARY-path notification target. Its scope is instead expressed as RELATED
entries — one per currently-matched resource, watcher = that rule's own
query agent key (`scopeRelated`/`scopeRelatedResources`, `src/rules/execution.ts`)
— reusing exactly the same related-watcher delivery `runResourceLoop`
(`src/daemon/loop.ts`) already has for a boss hearing its implementer:
per-change dedup (the loop's own `sent` set), the existing own-write echo
suppression (`deps.suppress`), and each provider's own per-resource event
rules (status/comment/title diffing) run UNCHANGED over this different input
list. A resource newly entering the scope needs no special "create" case
either — it simply has no `before` entry when its provider's event rules
diff the (prev, next) related snapshot, which every provider already reports
as `{ appeared: true }` (the same mechanism a freshly-Implements-linked
ticket already gets).

For `jira-work`, the query's own scope entries are merged (`mergeRelated`,
union of watcher sets per ticket) with the pre-existing Implements/Relates
chain (`relatedForRules`, UNCHANGED) — a ticket named by both is watched by
both. The Implements/Relates chain ITSELF is not extended to query-level
agents (a query-level agent does not participate as an Implements
listener/source) — out of scope for this story, same as the routing PRs
#370/#372 already shipped, unaffected. `jira-idea` mirrors this (its own
scope entries merged alongside its pre-existing GitHub-issue-hearing
relationship). `github-issue`/`zendesk-ticket` had no prior "related"
mechanism at all — scope entries are their only one.

**Swarm event routing is completely unchanged**: `changedPrimary` is computed
only from `"resource"`-kind units (which a `singleton`/`persistent` rule
never produces), so a swarm rule's own diffing/suppression/delivery is
byte-for-byte the same code path as before this story, mixed rule sets
included.

## MCP identity for a query-level agent (BUTCHR-398)

A query-level agent has no single resource, so it identifies to the daemon's
MCP endpoint with `x-butchr-agent` ALONE — never `x-issue` — for every
provider, jira-work included (Task 1 left `jira-work` per-resource agents
sending `x-issue`; a query-level jira-work agent is NOT one of those, and
sending its own `%40query`-suffixed key as `x-issue` would be exactly the
bogus-resource hazard the next section closes, one layer earlier).
`mcpIdentityHeaders`/`buildWorkspace` (`src/agents/workspace.ts`) check
`isQuerySpec`/`decodeAnyAgentKey` BEFORE the existing `isKeyOnly`
(github-issue/jira-idea/zendesk-ticket) branch, so this applies uniformly
regardless of provider.

`callerIdentity` (`src/mcp/identity.ts`) recognises this as its own
`CallerIdentity` variant — `{ provider, agent, ruleId, query: true }` —
refused (`null`) only if it ALSO carries `x-issue` (the same double-identity
refusal every key-only provider branch already applies). The `agy` provider
bridge's `.butchr-agy.json` shape for a query-level workspace is
`{ agent, mcpUrl }` alone (`src/mcp/workspace.ts`) — no `issue`/`resource`
field, checked before the `KEY_ONLY_PROVIDERS` branch since this applies to
jira-work too.

Beyond identifying itself and connecting, a query-level agent's own MCP tool
surface is unchanged by this story — it uses the same per-provider
read/comment tools any agent of its provider does, each already taking an
explicit resource argument where one is needed.

### What tools a query-level agent has (BUTCHR-398 review finding 2)

A query-level agent's tool surface is DELIBERATELY narrower than a
per-resource agent's, because most of what it lacks is a genuine consequence
of having no single resource, no ticket, and no doc — not an oversight:

- **Per-resource read/comment tools still work, unchanged**, because they
  already take an explicit resource argument rather than resolving "my own
  ticket" from the caller's identity: `jira_get_issue`, `jira_search`,
  `jira_add_comment`, `jira_transition`, and the equivalent per-provider
  tools (`github_get_issue`/`github_add_comment`, `jira_idea_get`/
  `jira_idea_add_comment`, `zendesk_get_ticket`/`zendesk_add_internal_note`)
  all take the resource they act on as an argument, so a query-level caller
  uses them exactly as any other agent of its provider does — across every
  resource in its scope, not just one.
  - **`jira_add_comment`'s identity tag** (`src/tools/defs.ts`) is built
    from the caller's `x-issue`, which a query-level agent never sends —
    falls back to `x-butchr-agent` (the same precedence `audit()`'s writer
    line and `src/tools/outcome.ts`'s caller field already use), so a
    query-level agent's comment is tagged with its own agent key rather
    than posting untagged (which, by this tool's own house convention, an
    untagged comment on the shared account reads as a human's).
- **`get_doc`/`set_doc` and every BUTCHR-35 relationship verb
  (`new_worker`, `start_worker`, `report_to_boss`, `ask_boss`,
  `submit_to_boss`, `tell_worker`, …) REFUSE a caller with no `x-issue`**
  (`requireCaller`, `src/tools/defs.ts`) — a DELIBERATE, unchanged decision,
  not a gap this story closes: a query-level agent genuinely has no single
  ticket to own a doc on, no boss (an `Implements` link names a specific
  ticket's boss), and nothing for `report_to_boss`/`ask_boss` to route to.
  These verbs simply are not applicable to a query-level agent's own
  identity; its own brief should not teach them.
- **Its own Confluence doc**: because `set_doc`/`get_doc` are unreachable
  for it (above), a query-level agent has no doc of its own — its own
  brief/`SpawnSpec` (the "What the query-level agent is told at spawn"
  design, Section A of this task) is its only durable instruction surface.

## The `resourceKeyOf` hazard — audited and closed (BUTCHR-398)

`resourceKeyOf(id)` (`src/agents/workspace.ts`) is `decodeAgentKey(id)?.resourceId
?? id` — for a query-level id, `decodeAgentKey` always rejects it (by
design), so `resourceKeyOf` falls back to the id ITSELF: the whole bogus key
(e.g. `jira-work:triage:%40query`). BUTCHR-397's review flagged every call
site that could feed that fallback into a live Jira/GitHub/Zendesk lookup or
a comment write. Re-audited for this task:

| consumer | verdict |
|---|---|
| `src/daemon/index.ts`: `issueForPane` (feeds `escalator.onBlocked`/`onNoPrompt`) via `resourceOfCwd`/`ownedAgentOfCwd` | **fixed — the sharpest gap found in review.** A blocked persistent/singleton agent's dialog escalation would otherwise post `speakOnOwnChannel`'s `ops.addComment` against the bogus `@query` key (a doomed Jira write, silently 404ing and logged, never reaching anyone). New `escalationTargetOfCwd` uses `singleResourceOf` (`src/agents/workspace.ts`) instead of `resourceKeyOf`, so a query-level pane resolves to `null` — routed through `escalation-loop.ts`'s own PRE-EXISTING, loud `issue === null` → `"blocked with an unanswerable prompt but no issue key — cannot escalate"` path, verified live to already exist rather than assumed. `resourceOfCwd` itself is unchanged for the dashboard/label-sync status map, where the bogus fallback is a harmless orphan entry, not a write. |
| `src/daemon/index.ts`: `issueCrashLoopDetector`/`issueReconcileFailureDetector`'s `addComment`/`comments` | fixed — a query-level id (`isQueryLevelAgent`) skips the Jira write/read entirely (logged, not silent) rather than acting on the bogus key. |
| `src/daemon/index.ts`: the jira-work loop's `onRespawn` | fixed — a query-level agent's respawn notice is skipped (no ticket to post to). |
| `src/daemon/github-issue-loop.ts`/`zendesk-ticket-loop.ts`/`jira-idea-loop.ts`: `notify` | fixed — each now derives the notified resource from `about` (the ticket that actually changed, via the related path) rather than unconditionally from `resourceKeyOf(agent)`, which for a query-level agent is its own bogus key, not a real resource — this was previously safe only because `about === agent` always held (no related delivery existed for these providers before this story). |
| `src/daemon/index.ts`: `issueMeta.get(resourceKeyOf(key))` (dashboard/state summaries) | improved — `metaFor` synthesizes a `"<rule> (query agent)"` summary for a query-level id instead of the bogus key silently looking up nothing (already safe from a crash standpoint; this closes the "dashboard/link garbage" half). |
| `src/daemon/index.ts`: `resolveResourceLink(resourceKeyOf(key), ...)` | already safe, unchanged — `isIssueKey`/`isProjectId` reject a query-level id's bogus fallback outright, producing an honest "cannot resolve" refusal, never a wrong link. |
| `src/daemon/index.ts`: `isStaffed`, `resourceOfCwd`/`agentStatuses` (label-sync status map) | already safe, unchanged — a query-level id's bogus `resourceKeyOf` fallback never equality-matches a real ticket key, so it is either ignored (`isStaffed`) or becomes a harmless unread orphan map entry (label sync only ever looks up REAL ticket keys from search results). |
| `src/agents/herd.ts`: `staleIssues()`'s internal `decodeAgentKey`, `resourceQuotaBlocked` | left as-is (BUTCHR-397's own verdict, reconfirmed): each degrades to its existing null-decode behaviour for a query-level key (no `resource` field passed to `spawnArgs`; never matches a real resource id) rather than crashing. |
| `buildWorkspace`, `mcpIdentityHeaders`, `SpawnSpec` (`src/agents/workspace.ts`) | **implemented this task** — see "MCP identity for a query-level agent" above; this is exactly the follow-up BUTCHR-397 named. |
| `src/tools/defs.ts`: `jira_add_comment`'s identity tag (built from `x-issue`) | fixed — falls back to `x-butchr-agent` when `x-issue` is absent (a query-level jira-work agent), so its comment is tagged with its own agent key rather than posting untagged (see "What tools a query-level agent has" above). |

No lookup or write anywhere in this codebase now keys a live Jira/GitHub/Zendesk
call off a query-level agent's own id — `test/unit/execution-modes.test.ts`
pins this directly.

## Fleet capacity role (BUTCHR-398, epic decision on BUTCHR-391, 2026-09-25T00:25Z)

A late-arriving requirement, folded into this task rather than a new one so
it did not wait on the fleet's own agent cap. Independent of `execution` and
`account`.

- **`role: "worker" | "sentinel"`, default `"worker"`.** Every rule is a
  worker unless explicitly flagged otherwise — existing rules files need NO
  change to keep their cap, and there is deliberately no startup warning for
  an unflagged rule (the polarity the epic settled on, superseding an
  earlier draft that would have required opt-in — see BUTCHR-391 comment
  history for the correction).
- **A worker** counts toward `BUTCHR_MAX_AGENTS` and is subject to admission
  withholding exactly as every agent was before this field existed.
- **A sentinel** — a swarm rule's every per-resource agent, or a
  singleton/persistent rule's one query-level agent — is NEVER withheld and
  NEVER counted toward residency. Workers' own admission decisions
  (ordering, budget, the implausible-zero guard) are computed as though
  sentinels did not exist: `AdmissionControllerDeps.roleOf` (an optional
  classifier, `src/agents/admission.ts`) partitions both the residency
  census and each poll's spawn candidates into workers/sentinels before any
  of the existing cap logic runs; sentinel candidates are appended to the
  admitted set unconditionally, bypassing withholding and both fail-safe
  paths alike (a sentinel was never subject to the cap to begin with, so a
  residency-census outage has nothing to withhold it from).
- **Fail-safe**: an id whose rule cannot be resolved (`decodeAnyAgentKey`
  fails, or its rule has since been removed) is always a WORKER — an
  unrecognised agent silently escaping the cap would be the opposite of
  safe.
- **FACTORY-757: capacity is a per-query decision, not a per-issue-type
  one.** Earlier (BUTCHR-422/FACTORY-39), `capacityRoleFor`
  (`src/agents/capacity-role.ts`) also exempted any Jira work item whose
  issue type was Epic, Story or Bug, regardless of its rule's own `role` —
  a `jira-work`-specific special case layered on top of this field. That
  hardcoding is gone: an `epics`/`stories`/`bugs`-shaped rule now counts
  exactly like any other rule, unless it explicitly sets `role: "sentinel"`
  itself. This is a deliberate behaviour change — a live rules file that
  relied on the old issue-type exemption now needs to add `role: "sentinel"`
  to each rule it wants exempt (no migration ships with this change; see
  this ticket, FACTORY-757, for why).
- **`jira-project` is still always a sentinel** (BUTCHR-425), unconditionally
  — `capacityRoleFor` checks the resource provider before ever consulting
  the rule's own `role` field. Free-form project managers are
  operator-directed, not admission-capped workers: Codey runs dozens of
  them, and none may consume `BUTCHR_MAX_AGENTS`. Unlike the issue-type
  exemption just above, this ONE exception survived FACTORY-757's cleanup on
  purpose — removing it would require every live `jira-project` rule to add
  `role: "sentinel"` just to keep today's behaviour, which is exactly the
  migration this ticket's definition of done rules out. This is a DIFFERENT
  mechanism from the `role` field's own default — a `jira-project` rule that
  never sets `role` at all (every live rule today) still gets `"sentinel"`,
  not the field's own `"worker"` default. A bare project-tier agent (no rule
  at all — the project-wide agent, e.g. a plain `BUTCHR` id) is sentinel for
  the same construction-level reason: there is no rule to ask for a `role`.
- **Reporting**: the `[admission2]` log line and the `/dashboard` admission
  panel report `residency(workers)=<n> sentinels=<m>` — a deliberate format
  change from the old bare `residency=<n>` (same convention `ADMISSION2_TAG`
  itself was introduced under: a visibly different shape, not a silently
  reinterpreted old one). Every sentinel rule is also logged once at daemon
  startup, naming its rule id and role, so an operator can see at a glance
  what is exempt from the cap.

`daemon/index.ts` wires ONE `roleOfAgent` classifier (built from the full
loaded `rules` list, so it works across every provider) into the single
shared `AdmissionController` instance every rule loop's admission bucket
already draws from.

## Per-rule admission rate limiting: `maxNewPerTick` / `minSecondsBetweenAdmissions` (FACTORY-907, epic FACTORY-906)

**Rationale**: lowering a rule's priority filter can land a whole batch of
workers on one poll — 4 cores can't absorb that; measured live, load5 hit
49 within 4 minutes at 21:50 PDT. The fleet-wide cap (`BUTCHR_MAX_AGENTS`,
`src/agents/admission.ts`) bounds how many agents are RESIDENT at once, but
says nothing about how FAST one rule's own lane may claim that cap on a
single poll. These two fields are that per-rule throttle:

- **`maxNewPerTick?: number` (integer ≥ 1)**: at most this many NEW agents
  (desired but not yet running) are admitted for this rule per `admit()`
  call.
- **`minSecondsBetweenAdmissions?: number` (integer ≥ 1)**: at most one new
  admission for this rule every this-many seconds, wall-clock.
- **Both set**: both must allow — neither field overrides the other.
  `minSecondsBetweenAdmissions` can still block a second admission within
  one call even when `maxNewPerTick` alone would have allowed it.
- **Absent (either or both)**: today's behaviour exactly, byte-for-byte —
  no log line changes, no ordering changes, nothing.
- **Never affects an already-running agent**, and **never raises the fleet
  cap** — this only ever narrows how much of that cap one rule's lane may
  claim on one poll. The shared cap still applies on top: a candidate this
  limiter would allow can still be cap-withheld, and that is logged and
  counted as a CAP withholding, never a rate-limit one (see
  `admitWithRateLimits`'s own doc comment, `src/agents/admission.ts`, for
  why the two are computed in one pass rather than two, to keep that
  distinction honest).
- **Deferred, never dropped**: a candidate the rate limit holds back this
  poll is retried on the next one, in the SAME wait-ordered position
  (`orderByWait`) it would have had anyway — it shares the exact wait
  ledger a cap-withheld candidate already uses, so it is never marked
  stalled, blocked, or withheld-by-cap, and a candidate that leaves
  `desired` for good (ticket closed) is reclaimed by the same
  evict-after-unseen bound (`LEDGER_UNSEEN_EVICTION_CALLS`) cap-withholding
  already relies on.
- **No persisted state**: both counters (this call's admission count per
  rule, and each rule's last-admitted wall-clock time) live only in the
  `AdmissionController` instance's own memory. A daemon restart starts
  fresh and re-derives purely from live state — there is nothing to
  migrate or clean up on disk.
- **Reporting**: a deferral fires `[admission2] rate-limit rule=<id>
  admitted=<a> deferred=<d> maxNewPerTick=<n> minSeconds=<m> next-in=<s>s`
  — a DISTINCT line from the ordinary `[admission2] cap=... admitted=...
  withheld ...` line (same `[admission2]` tag, extended, never a silently
  reinterpreted shape), one per rule that actually had a candidate deferred
  by its own rate limit this call, throttled to at most once per rule per
  60 seconds so a saturated rule's own deferral cannot spam every poll. A
  field this rule left unset prints `-`, never a number that would
  misreport it as configured.
- **Read-only in the rules API/preview** (`GET /api/rules`) as
  `maxNewPerTick`/`minSecondsBetweenAdmissions`, `null` when unset — not yet
  on the web write surface (a later story, same discipline as every other
  read-only-for-now field this endpoint already carries).

Example:

```json
{
  "id": "triage",
  "resourceProvider": "jira-work",
  "query": "project = FACTORY AND status = \"To Do\"",
  "brief": "Pick up a newly assigned ticket.",
  "maxNewPerTick": 2,
  "minSecondsBetweenAdmissions": 30
}
```

— admits at most 2 new `triage` agents per poll, and never more than one
every 30 seconds, regardless of how many tickets a lowered priority filter
just made eligible all at once.

## Herdr workspace labels: short display ids, collisions, and full-key metadata (FACTORY-95, implementing FACTORY-90, epic FACTORY-83)

Before this ticket, `HerdrHerd.spawn()` (`src/agents/herd.ts`) set the herdr
workspace's visible `label` to the RAW agent key, e.g.
`filesystem:managed-sessions:%2Fhome%2Fbrooswit%2F.config%2Fbutchr%2Fsession-definitions%2Fadmin-assembly.json`
— unreadable in `herdr workspace list` and the herdr UI, where a long shared
prefix truncates every agent to the same-looking string. **This label was
never anything other than free text** — nothing in butchr's own ownership or
reconcile logic ever matched on it (FACTORY-89 confirmed and locked that in
first: reap/residency key exclusively on the pane's `cwd`, via
`agentIdOfWorkspacePath`, never on `workspace.label`), so changing it here
carries no correctness risk of its own.

### The naming spec (operator, verbatim — FACTORY-83's 2026-09-26T19:47Z comment)

> for query resource agents, its the resource ID of the resource they are
> associated with. Every provider decides what that resource id is. For jira
> issues, its the issue id (FACTORY-20). For directories, its the directory
> and parent directory (brooswit-factory:rinth).

### One method per provider, not a central switch

`src/rules/display-label.ts` is the module this ticket adds. Its job is
narrow: **dispatch** a decoded agent key's `resourceProvider` to that
provider's OWN short-id method, then combine the result with the rule id.
It is not itself a second implementation of any provider's logic — each
provider/rule-type module owns its own named export:

| provider | method | module | shape |
|---|---|---|---|
| `jira-work` | `jiraWorkShortDisplayId` | `resource-type.ts` | identity — the resourceId already IS the issue key, e.g. `FACTORY-20` |
| `jira-idea` | `jiraIdeaShortDisplayId` | `jira-idea-type.ts` | identity, same shape as `jira-work`, independently |
| `jira-project` | `jiraProjectShortDisplayId` | `jira-project-type.ts` | identity — the resourceId already IS the project key |
| `filesystem` (ordinary dirs/files) | `filesystemShortDisplayId` | `filesystem-type.ts` | `<parent>:<name>`, e.g. `brooswit-factory:rinth` |
| `filesystem` + `MANAGED_SESSIONS_RULE_ID` (managed sessions) | `managedSessionShortDisplayId` | `session-definition-type.ts` | the bare definition name, `.json` stripped, e.g. `admin-assembly` — see below |
| `github-issue` | `githubIssueShortDisplayId` | `github-issue-type.ts` | `<repo>#<number>`, owner dropped, e.g. `butchr#42` |
| `github-pr` | `githubPrShortDisplayId` | `github-pr-type.ts` | same shape as `github-issue`, independently, sharing `shortGithubRef` (`github-issue-ref.ts`) |
| `zendesk-ticket` | `zendeskTicketShortDisplayId` | `zendesk-ticket-type.ts` | `#<id>`, subdomain dropped, e.g. `#4567` |

A query-level agent (BUTCHR-397 `singleton`/`persistent` — no single
resource) has no short id to compute at all: it displays its bare `ruleId`.

### The managed-sessions exception, and why

A managed-session agent is, underneath, a `filesystem`-provider resource
(BUTCHR-407/BUTCHR-408) — but it does NOT use the generic
`filesystemShortDisplayId` `<parent>:<name>` rule. Applied literally to a
definition file's path, that rule would give
`session-definitions:admin-assembly.json` (the well-known definitions
directory is always its parent). FACTORY-83 recorded the deliberate call:
a managed session is memorable by its own name alone — the parent is always
the same fixed root, so naming it on every label adds noise, not
information, unlike an arbitrary filesystem resource where the parent is
exactly what disambiguates "which `rinth` is this." `display-label.ts`'s one
dispatch point tells the two apart by **rule id**
(`MANAGED_SESSIONS_RULE_ID`), never by provider alone. A managed session's
label also has no `<ruleId> · ` prefix — every session shares the same
reserved rule id, so appending it would be pure noise.

### Combining a short id with the rule id

An ordinary resource agent displays `"<ruleId> · <shortId>"`, e.g.
`"jira-work · FACTORY-51"`.

### Collisions: deterministic and loud

Two different resources can legitimately reduce to the same short id — the
same `<parent>:<name>` reached under two different roots, or two
query-level rules from different providers that happen to share a rule id.
`resolveDisplayLabels(agentKeys, log?)` computes every key's label in one
pass and disambiguates any group that collides:

- The lexicographically **smallest agent key** of a colliding group keeps
  the bare label; every other member gets a `-<hash>` suffix, where `<hash>`
  is the first 6 hex characters of that key's OWN SHA-256 (the same "hash
  the exact key" mechanism `nameFor` in `herd.ts` already uses for herdr's
  32-character agent-name limit).
- The tie-break is a pure function of the full key set, never of spawn
  order or discovery order — this is what makes it reproduce identically at
  spawn time and at relabel-in-place time, and across a daemon restart
  (FACTORY-90's own "stable ... both ways" requirement). It does not, and
  cannot, promise a label never changes: adding or removing a colliding
  resource can shift a group's tie-break, which is exactly why
  relabel-in-place (below) is safe, and meant, to be re-run.
- One WARNING line is logged per colliding GROUP, naming every member —
  never once per key, so an N-way collision doesn't spam N lines.

### Wiring: spawn time and relabel-in-place

`HerdrHerd.labelFor(key)` (`src/agents/herd.ts`) computes a fresh spawn's
label by adding `key` to every OTHER currently-running, butchr-owned agent's
key (`ownedWorkspaceIds()`) and running `resolveDisplayLabels` over that
set — so a brand new spawn is checked for collisions against the fleet as it
exists right now. This value replaces the old `label: spec.key` at the one
call site FACTORY-90 named (`this.lifecycle(spec.key).start({..., label,
...})`).

**Review fix, round 1 — a spawn-time collision must not wait for a restart
to resolve.** `resolveDisplayLabels`'s tie-break (the lexicographically
smallest key of a group keeps the bare label) is independent of spawn
order by design — but that independence means a NEW key that happens to
sort BEFORE an already-running colliding key would otherwise be handed the
same bare label the running workspace already visibly carries: two live
workspaces sharing one label until the next `relabelOwnedWorkspaces()` pass,
which only runs at daemon startup. `labelFor` closes this by also
reasserting every OTHER running member of `key`'s own collision group's own
correct label, right then, via the same `relabelRunningAgent` path
`relabelOwnedWorkspaces` uses (unconditionally, not only the members whose
label actually changed — both herdr calls are cheap, idempotent overwrites,
and this way never depends on trusting that herdr's own stored value
already agrees). The result: no two live workspaces ever share a label,
regardless of which key sorts first.

`HerdrHerd.relabelOwnedWorkspaces()` does the equivalent for every
ALREADY-RUNNING, butchr-owned workspace in one pass: ownership is proven the
same way `reap.ts`'s `strandedCandidates` proves it for its own purpose — a
pane's `cwd`, run through `agentIdOfWorkspacePath`, resolving to a real agent
key — **never** via herdr's own current label (the label is exactly what is
about to change, so trusting it as an identity source here would be
circular). `herdr.workspace.rename({workspace_id, label})` moves the visible
name with no agent restart. This is idempotent (a plain overwrite, safe to
call repeatedly) and, as of this ticket, called once at daemon startup
(`src/daemon/index.ts`) — cheap enough that running it again on the next
restart is exactly as safe as running it the first time; `labelFor`'s own
mid-spawn sibling fix-up (above) is what covers the gap between restarts.

### Full-key metadata

The visible label never carries the full agent key — that stays in herdr's
own per-workspace metadata bag, `workspace.reportMetadata`. Both write
sites (`HerdrHerd.reportFullAgentKey` after a successful spawn, and
`relabelOwnedWorkspaces` for an already-running workspace) use the same two
constants from `display-label.ts`:

- **field name**: `FULL_AGENT_KEY_METADATA_FIELD = "agentKey"`
- **source tag**: `METADATA_SOURCE = "butchr"`

so `herdr workspace list`'s `tokens.agentKey` is the full, machine-usable
key for any butchr-owned workspace, spawned before or after this ticket
(relabel-in-place backfills it for every pre-existing one on the next daemon
restart). A metadata-write failure is logged as its own WARNING and
swallowed — it must never read as a failed spawn (the agent is already
running) or block another workspace's own relabel.

## Tests

`test/unit/rules.test.ts` covers `execution`/`account` (BUTCHR-397, unchanged)
and `role` (BUTCHR-398: defaults, provider-generic acceptance, bad-value
rejection, pre-change-document compatibility) at the schema layer, and the
query-level codec itself (encode/decode round-trip, non-collision, restart
stability). `test/unit/mcp-identity.test.ts` and `test/unit/mcp-workspace.test.ts`
cover the query-level MCP-layer identity (BUTCHR-398 update: now recognised,
not refused). `test/unit/execution-modes.test.ts` (BUTCHR-398, new) covers:
`groupExecutionUnits`/`scopeRelated`/`mergeRelated`/`logExecutionModeSwitches`
as pure functions; end-to-end reconciliation convergence (N / 0-or-1 / 1
across all three modes, 0→k→0 for singleton, persistent at N=0, freeze/off
stopping persistent, restart adoption with no duplicate spawn, a failed poll
changing nothing, and a live swarm→singleton mode switch both logging loudly
and converging correctly in one poll); event delivery to a query-level
agent's scope (create/status/comment, dedup, own-write suppression, a swarm
regression proof); the `resourceKeyOf` hazard (a query-level id never looks
like a real resource id); and the fleet capacity role (never withheld, never
counted, fail-safe-as-worker, separate `[admission2]` reporting). Every test
in that file fails to even load against pre-change `BUTCHR-392` (`git show
origin/BUTCHR-392:src/rules/execution.ts` does not exist) — verified live by
copying the file into a worktree checked out at that commit and running it
there: 0 pass, 1 fail (module not found).

`test/unit/display-label.test.ts` (FACTORY-95, new) covers every provider's
own short-id method directly (including the managed-sessions special case
proven to differ from the generic filesystem `<parent>:<name>` rule applied
to the same path), `baseDisplayLabel`'s combination rule for an ordinary
resource agent / a managed session / a query-level agent / a legacy id, and
`resolveDisplayLabels`'s collision handling (no false positives, a two-way
collision disambiguated with one warning and a stable suffix, a three-way
collision leaving exactly one bare winner, cross-provider query-level
collisions, and determinism regardless of input order or of which "universe"
of keys — spawn-time vs. relabel-in-place — a key is resolved against).
`test/unit/herd.test.ts` adds the wiring-level coverage: a spawn's label is
its short display id rather than the bare key (legacy ids unaffected); a
spawn colliding with an already-running agent is proven in BOTH sort
orders — when the incoming key sorts after the running one, the new
workspace is suffixed and the running one's own already-correct bare label
is reasserted; when it sorts before, the new workspace gets the bare label
AND the running workspace is relabeled to the suffix in the same call, so
no two live workspaces ever share a label regardless of ordering (the
review-round-1 fix); a successful spawn's full key lands in herdr metadata
(a failed one reports none); and `relabelOwnedWorkspaces` renames/reports
metadata for every owned running workspace (never an unowned one, proven
via cwd, never via herdr's own label), disambiguates the same way
spawn-time does, is idempotent, and never lets a herdr hiccup or one
workspace's own failure block the rest.

## Workspace DIRECTORY layout: short leaves, lossless resolution, and the memory-slug migration (FACTORY-118, implementing FACTORY-91, epic FACTORY-83)

The section above gives every resource agent a short herdr **label**. This
ticket applies the SAME per-provider short id (`shortDisplayId`,
`src/rules/display-label.ts` — reused, never a second naming scheme) to the
on-disk workspace **directory**'s leaf, so e.g.
`<root>/filesystem/managed-sessions/%2Fhome%2F...%2Fsession-definitions%2Fadmin-assembly.json`
becomes `<root>/filesystem/managed-sessions/admin-assembly`. Full details,
the empirical Claude Code slug-algorithm verification, the required Servy
proof (with its negative control), and the operator deploy runbook all live
in **`docs/workspace-layout.md`** — this section is the short pointer + the
one correction to the section above that this ticket's own story made after
the fact.

**Correction to "Collisions: deterministic and loud" above:** that section
correctly describes `collisionSuffix` as stable (a pure hash of the full
key), but a label's BARE-vs-SUFFIXED tie-break (which member of a colliding
group keeps the bare name) is NOT stable — `resolveDisplayLabels`'s own doc
comment says a label "can change over time" as other colliding keys come and
go. That is fine for a disposable herdr label. It is NOT fine for a
directory that holds memory, transcripts and git worktrees: recomputing a
DIRECTORY's leaf the same way would rename a workspace out from under itself
for a reason that has nothing to do with that workspace. `newLayoutDirFor`
(`src/agents/workspace.ts`) therefore does not reuse `resolveDisplayLabels`'s
tie-break at all — it chooses a leaf ONCE, at first claim, sticky forever
after via the bookkeeping stamp described in `docs/workspace-layout.md`.

Three points worth knowing without opening that doc:

1. **The leaf is the provider's short id alone**, never combined with the
   rule id the way a herdr LABEL combines it (`"<ruleId> · <shortId>"`) — a
   workspace path already carries the rule id as its own separate directory
   segment (`<provider>/<ruleId>/<leaf>`), so appending it into the leaf too
   would duplicate it. `jira-work`/`jira-idea`/`jira-project`'s identity
   short ids mean those three providers see **no directory change and no
   filesystem write at all** — only `filesystem`, `github-issue`,
   `github-pr` and `zendesk-ticket` workspaces ever actually move.
2. **A short id is not a lossless encoding of the resource id** (unlike the
   pre-ticket `encodeURIComponent`-escaped leaf), so the reverse mapping
   `agentIdOfWorkspacePath` (a pane's cwd -> its agent key — every
   ownership/reap/residency/reconcile decision in the fleet depends on this)
   needed a lossless mechanism that does not depend on decoding the leaf: a
   bookkeeping stamp file written inside the directory at claim time. An
   old-layout (still fully percent-encoded, not yet migrated) workspace
   keeps decoding exactly as it always did — nothing about pre-ticket
   directories changed.
3. **Renaming an existing workspace's directory also has to move Claude
   Code's own `~/.claude/projects/<slug-of-cwd>` memory/transcript
   directory**, or the agent silently loses every prior conversation the
   next time it resumes — the hazard this whole ticket exists to close.
   `docs/workspace-layout.md` has the empirical proof this actually works
   (and, separately, an actual failure mode this ticket found and fixed:
   Claude Code truncates-and-hashes a slug over 200 characters in a way this
   codebase cannot reproduce, so a migration whose NEW path would trip that
   threshold refuses loudly rather than silently guessing wrong).

`test/unit/workspace.test.ts` and `test/unit/workspace-migration.test.ts`
carry this ticket's own test coverage (leaf validation against hostile short
ids, sticky/collision resolution, slug-collision detection, the migration's
idempotent/reversible/never-overwrite-non-empty properties and their edge
cases, and `planWorkspaceMigration`'s pure decision logic for the operator
script). `test/unit/herd.test.ts`, `test/unit/missing-rules-preflight.test.ts`
and the other caller files listed in `docs/workspace-layout.md`'s own
"Callers updated" section cover Addendum A5's fail-open bar: a mixed fleet
of old-layout and new-layout agents recognised identically, stably, across
repeated polls — the FACTORY-47/FACTORY-75 class of bug, in a new place.
