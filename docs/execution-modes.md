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

**Provider scope.** All three fields are accepted for all four resource
providers (`jira-work`, `github-issue`, `jira-idea`, `zendesk-ticket`).

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
do), how connection material reaches the agent (a 0600 file, never argv),
and what happens when the RC user-cap guardrail refuses (the spawn is
withheld, not degraded).

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
