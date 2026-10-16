# Per-rule notification delivery mode (FACTORY-1010)

`Rule.notifyDeliveryMode` lets a rule pin its own agent(s)' update/notification
delivery to exactly one transport, instead of the daemon's existing
channel-first, prompt-on-unavailable behavior.

## Values

- Absent (the default): today's behavior, unchanged. Every delivery seam
  tries the agent's MCP dev channel first; if the channel is unavailable,
  refused, or the push itself throws, it falls back to a direct typed
  prompt. This is exactly what every rule got before this field existed.
- `"channel"`: send ONLY over the MCP channel. If the channel is
  unavailable, the seam reports a clear non-delivery result — it never
  falls back to the prompt.
- `"prompt"`: send ONLY as a direct typed prompt. The channel is never
  even attempted.

There is no `"both"` value: an explicit choice never doubles delivery, and
never silently tries the other transport.

```json
{
  "id": "tasks",
  "resourceProvider": "jira-work",
  "query": "assignee = currentUser() AND issuetype = Task",
  "brief": "@builtin:task",
  "notifyDeliveryMode": "channel"
}
```

## Clearing back to the default

Through `PUT /api/rules/:id`, sending `notifyDeliveryMode: null` REMOVES the
field from the stored rule, returning it to the omitted/default behavior.
Omitting the field from a PATCH body leaves whatever is currently stored
unchanged — `undefined` and `null` mean different things here, the same
`stalledMinutes` precedent already uses (`src/rules/rules.ts`,
`src/rules/rules-write-apply.ts`).

## What is covered

Every rule-owned delivery seam that routes through the shared
`deliverNotice` gate (`src/notify/deliver.ts`) threads the owning rule's
`notifyDeliveryMode` in, resolved once per agent key via
`ruleNotifyDeliveryMode` (`src/daemon/index.ts`) — an agent key carries
exactly one owning rule, so this is a direct lookup, never a multi-rule
merge:

- the `jira-work` rule engine (`notifyRuleAgent`, including linked-change
  and PR-review-state nudges)
- `github-issue`, `github-pr`, `jira-idea`, `zendesk-ticket`, `filesystem`
  and `confluence-page` rule loops

## What is deliberately out of scope

- **The idle-poke engine** (`src/agents/idle-poke.ts`) — a stall-remediation
  wake nudge, not an update notification, and already resolved per-ISSUE
  across however many rules match it (`idlePokeRuleConfigByIssue`). Merging
  a categorical transport choice the same way `idlePokeEnabled`/
  `idlePokeMinutes`/`idlePokeMessage` already merge is left to a follow-up.
- **The managed-sessions loop** — its agents come from `SessionDefinition`
  manifests, never a `Rule`, so there is no `notifyDeliveryMode` to read.

## Validation and surfacing

Validated in `src/rules/rules.ts`'s `parseRules` (one of `"channel"` /
`"prompt"`, or absent) and on the web write path (`src/rules/
rules-write-registry.ts`'s `validateRuleFieldPatch`, part of
`EDITABLE_TOP_LEVEL_FIELDS` — never risky, never requires `confirm`).
Surfaced read-only in `GET /api/rules` (`src/web/rules-api.ts`) and editable
from the Rules page's edit dialog (`dashboard-app/src/components/
RuleEditDialog.tsx`, a "notification delivery" select with a "butchr's
default" option that clears it).

## Delivery-result shape

`deliverNotice` (`src/notify/deliver.ts`) distinguishes an explicit choice
from the default fallback in its own result and `[notify]` log line:

- default channel success: `{ via: "channel" }` — unchanged, byte-for-byte.
- explicit `"channel"` success: `{ via: "channel", explicit: true }` —
  logged as "Claude channel delivered (explicit mode)".
- explicit `"channel"`, channel unavailable: `{ via: "none", reason }` — no
  prompt fallback attempted.
- explicit `"prompt"`: `{ via: "prompt", delivered, refusal? }` — no
  `fallbackReason` (that field means "the channel was tried and lost",
  which never happens in this mode).

None of these distinguish "accepted by the transport" from "the worker
actually consumed it in a new turn" — a transport receipt is not proof of a
resulting agent turn, same caveat every other seam in this codebase already
carries.
