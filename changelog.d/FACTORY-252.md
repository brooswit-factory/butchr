bump: major

### BREAKING

- **The hourly linked-eventing turn-rate cap is removed.** `maxLinkedTurnsPerHour`,
  `DEFAULT_MAX_LINKED_TURNS_PER_HOUR`, and `effectiveMaxLinkedTurnsPerHour`
  are gone from `src/jira-watch/linked-eventing.ts`; a linked-change notify
  is now delivered every single time a genuine diff is found, for every
  linked-eventing owner kind (`jira-work`, `jira-project`, a managed
  session opted in via `linkedEventingProjects`), with no turn-rate budget
  of any kind. The `[notify-suppressed] ... arm=rate-capped` log line and
  its `rateCappedSuppressedLine` emitter (`src/jira-watch/suppressed-log.ts`)
  are removed along with it — no code emits that arm any more.
  `maxLinkedTurnsPerHour` stays in the rules-file parser's accepted-key set
  (`src/rules/rules.ts`'s `REMOVED_RULE_FIELDS`) purely as an upgrade
  affordance: an already-deployed `rules.json` carrying the old field still
  loads instead of failing every rule with "unknown field," but the field
  is parsed into nothing and never throttles delivery, even at its old
  value. `maxLinkedItems` (the separate linked-ITEM-COUNT cap) is
  UNCHANGED and still enforced exactly as before — only the turn-rate half
  of BUTCHR-471's two caps is removed.

### Removed

- `maxLinkedTurnsPerHour` from the `Rule` schema's active/validated field
  set (still accepted, migration-only — see above).
