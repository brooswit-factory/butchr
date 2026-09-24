# `execution` and `account`: rule schema, and query-level agent identity

BUTCHR-397 (task 1 of story BUTCHR-392, epic BUTCHR-391 — the Bakr/Candlestix
consolidation). This page covers what THIS task shipped: the `execution` and
`account` rule fields, their validation, and the identity codec for the one
agent a `singleton`/`persistent` rule runs. **Reconciling** those modes —
actually spawning, stopping, and delivering scope-wide events to a
query-level agent — is a separate task, BUTCHR-398, and is marked below
wherever this page describes something that task has not built yet. Nothing
on this page changes today's `swarm` behaviour, which is the default.

## The two fields

Both are optional on a `Rule`; a pre-BUTCHR-397 rules document loads
unchanged, with these two fields filled in at their defaults.

| field | values | default | independent of the other? |
|---|---|---|---|
| `execution` | `swarm` \| `singleton` \| `persistent` | `swarm` | yes |
| `account` | `none` \| `temporary` \| `permanent` | `none` | yes |

All nine `(execution, account)` combinations are valid at the schema level —
nothing here forbids pairing, say, `persistent` with `account: "none"`. A bad
value is rejected at load with the rule's index and field named, e.g.:

```
rules[2].execution must be one of swarm, singleton, persistent
```

**Provider scope.** Both fields are accepted for all four resource providers
(`jira-work`, `github-issue`, `jira-idea`, `zendesk-ticket`) — BUTCHR-397's
code read found no concrete blocker specific to any one of them, and the
story's own consumers need it across providers (Bakr wants singleton/
persistent; Candlestix's director sessions want persistent). Every provider
× every `execution` value is exercised in `test/unit/rules.test.ts`
("execution and account (BUTCHR-397)"). If a real per-provider blocker turns
up later, it belongs in validation (a rejection, never a silent ignore) —
raise it on BUTCHR-392 or a successor ticket first.

## What `execution` means

- **`swarm`** (today's only behaviour): one agent per matching resource, and
  none when nothing matches. Unchanged by this task in every respect —
  same keys (`encodeAgentKey`), same workspace layout, same reconciliation.
- **`singleton`**: one agent for the rule's WHOLE matching workload, not one
  per ticket. It stops when the query returns zero matches, and starts again
  when matches return.
- **`persistent`**: one agent even at zero matches. Only an explicit freeze
  (`enabled: false`) stops it — a query dropping to zero matches does not.

**Not yet implemented (BUTCHR-398):** actually spawning/stopping the one
`singleton`/`persistent` agent, and delivering it the events across its
rule's scope (creates, status changes, comments where the adapter supports
them). Setting `execution: "singleton"` or `"persistent"` on a rule today
validates and stores the value; no agent behaves differently because of it
until BUTCHR-398 ships.

## What `account` means

Rocket.Chat account lifecycle for a rule's agent(s), independent of
`execution`: `none` (nothing — today's behaviour, exactly), `temporary`, or
`permanent`. **Not yet implemented (a later story, S4):** creating,
attaching, or tearing down an actual Rocket.Chat account. This task adds and
validates the field only, so a rules file can declare the intent now without
waiting on S4 to land.

## The vendor selector: already there, not duplicated

The story's brief also asked for "a per-definition agent vendor/provider
(Claude or Codex)". BUTCHR-397's code read confirmed `agentPreferences[].harness`
(`"claude" | "codex" | "agy"`, `src/rules/rules.ts`) already IS that selector:
a rule's ranked `agentPreferences` picks which harness — and so which
vendor — runs its agent(s), for every provider, today. No second field was
added. `test/unit/rules.test.ts`'s "accepts every optional setting and
normalises" test pins a `codex` preference through `parseRules`, and the
`agent-providers.md`/`agent-model.md` docs already describe harness
selection in full; this page does not repeat it.

## Query-level agent identity

`swarm`'s identity is per-resource: `encodeAgentKey({resourceProvider, ruleId,
resourceId})` → `<provider>:<ruleId>:<resourceId>` (see `src/rules/agent-key.ts`).
That has no representation for "the one agent a `singleton`/`persistent` rule
runs" — there is no resource to name, and matched resources come and go
across polls while the ONE agent must not.

### The codec

```
encodeQueryAgentKey({ resourceProvider, ruleId })
  → <resourceProvider>:<ruleId>:@query        e.g. jira-work:triage:@query
```

- **Derived from provider + rule id ALONE, never a matched resource.** The
  same rule always produces the same key, on every poll and across every
  daemon restart — there is nothing else for reconciliation (BUTCHR-398) to
  converge on, which is exactly what lets it maintain exactly 0 or 1 owners
  for that rule instead of risking duplicates.
- **Same encoding discipline as `encodeAgentKey`**: each component
  percent-escaped (`encodeURIComponent`), and `decodeQueryAgentKey` requires
  canonical re-encoding — so, as with the per-resource codec, no two distinct
  strings decode to the same tuple.
- **Cannot collide with, or be mistaken for, a per-resource key of ANY
  provider.** The literal `@query` in the resource-id slot can never be a
  real resource id: every provider's native id format is checked against it
  in `test/unit/rules.test.ts` ("the query marker can never be mistaken for a
  real resource id") via `isResourceId`. That is WHY `decodeAgentKey` (the
  per-resource decoder) rejects every query-level key, and
  `decodeQueryAgentKey` rejects every per-resource key: proven, not assumed.
  `decodeAnyAgentKey(key)` decodes either shape, tagged
  `{ kind: "resource", ... }` or `{ kind: "query", ... }`, for code that must
  handle both — see "Everywhere this is wired in", below.

### Workspace layout: a sibling, never a parent

A per-resource workspace lives at `<root>/<provider>/<ruleId>/<resourceId>`
(`workspaceDirFor`, `src/agents/workspace.ts`). A query-level workspace lives
at `<root>/<provider>/<ruleId>/@query` — **the same depth**, a SIBLING inside
that rule's own directory:

```
<root>/jira-work/triage/BUTCHR-12/      ← a per-resource agent (swarm)
<root>/jira-work/triage/BUTCHR-31/      ← another one
<root>/jira-work/triage/@query/         ← the ONE singleton/persistent agent for this rule
```

This is deliberate: `encodeQueryAgentKey` puts the reserved marker in the
THIRD component (not a shorter two-component key) precisely so it shares its
`<provider>:<ruleId>:` prefix with that rule's per-resource keys and lands
one level further down, not on `<root>/<provider>/<ruleId>/` itself — which
is also the parent directory every per-resource workspace for that rule
already lives under. A query-level agent's own `CLAUDE.md`/`brief.md` living
in that shared parent, instead of its own sibling directory, would be exactly
the kind of layout collision this codec is required to avoid.

### Everywhere this is wired in

BUTCHR-397 audited every `decodeAgentKey` consumer in the codebase (grep
`decodeAgentKey` from a clean checkout to reproduce the list) so a
query-level key is never silently treated as legacy or unowned once BUTCHR-398
starts producing them. Verdicts:

| consumer | change |
|---|---|
| `workspaceDirFor`, `agentIdOfWorkspacePath`, `ruleAgentIdOfWorkspacePath` (`src/agents/workspace.ts`) | now use `decodeAnyAgentKey` — a query-level workspace round-trips through path ↔ key exactly like a per-resource one, and is findable again after a restart from its directory alone. |
| `ownsRuleAgent`, `ownsGithubIssueAgent`, `ownsJiraIdeaAgent`, `ownsZendeskTicketAgent` (one per provider's `*-type.ts`) | now use `decodeAnyAgentKey` — each provider's own query-level agent reads as owned by that provider's rule loop, same as its per-resource agents. |
| `legacyAgents` (`src/daemon/legacy-preflight.ts`) | now uses `decodeAnyAgentKey` — **this was the sharpest gap found**: with the per-resource-only decoder, a query-level workspace would have read as an unowned legacy workspace and made the daemon refuse to start the moment BUTCHR-398 created one. |
| `callerIdentity` (`src/mcp/identity.ts`) | now decodes with `decodeAnyAgentKey`; a query-level `x-butchr-agent` is refused (`null`) rather than crashing (e.g. `parseGithubIssueRef` on a missing resource id) or being silently read as a per-resource caller. `CallerIdentity` has no query-level variant yet — that shape is BUTCHR-398's call once it defines what MCP tools such an agent actually gets. |
| `bridgeWorkspace` (`src/mcp/workspace.ts`, the `agy` provider bridge) | now decodes with `decodeAnyAgentKey`; a query-level workspace is recognised structurally (never "Not a factory workspace") but refused on content (`.butchr-agy.json` has no defined query-level shape yet) rather than crashing. |
| `resourceKeyOf`, and `staleIssues`'/`resourceQuotaBlocked`'s internal `decodeAgentKey` calls (`src/agents/workspace.ts`, `src/agents/herd.ts`) | left on the per-resource-only `decodeAgentKey` deliberately: each is answering "what SINGLE resource does this agent work", which a query-level agent has none of. Each degrades to its existing null-decode behaviour (fall back to the id itself; omit the `resource` field) rather than crashing. |
| `buildWorkspace`, `mcpIdentityHeaders`, `SpawnSpec` (`src/agents/workspace.ts`) | **not touched.** These define how an agent is spawned and how it identifies itself over MCP — BUTCHR-398's job ("Task 2 will consume this codec to spawn/stop the agent"), since a query-level agent's `.butchr-agy.json`/MCP-header shape doesn't exist yet. Never called with a query-level key today. |
| `decodeAgentKey` calls in `src/rules/resource-type.ts` (event `decide`), `src/daemon/jira-idea-loop.ts` (cross-provider "heard" nudges), `src/tools/relationship.ts` (brief-summary rewrite) | left unchanged. Each only ever sees keys this task's own code still produces (per-resource `RuleMatch`es) — query-level agents have no `RuleMatch` until BUTCHR-398 builds their reconciliation, so these provably never see one yet. |

## Tests

`test/unit/rules.test.ts` ("query-level agent keys (BUTCHR-397)") covers the
codec itself: encode/decode round-trip, derivation from provider+rule-id
alone, non-collision with per-resource keys (for every provider), rejection
of anything not in canonical form, `decodeAnyAgentKey`'s tagged union, and
restart-stability (repeated encodes of the same inputs always match). It also
covers the ownership-predicate and legacy-preflight wiring above.
`test/unit/workspace.test.ts` covers the workspace-layout sibling property
and the `workspaceDirFor`/`agentIdOfWorkspacePath` round trip directly.
`test/unit/mcp-identity.test.ts` and `test/unit/mcp-workspace.test.ts` cover
the MCP-layer refusals.
