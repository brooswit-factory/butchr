---
bump: minor
---

### Added

- **Idle-poke fields on the `SessionDefinition` schema, shipped as config
  (epic FACTORY-836, story FACTORY-926, task FACTORY-942).**
  `src/resources/session-definition.ts` gains `idlePokeMinutes`/
  `idlePokeMessage`/`idlePokeEnabled`, reused VERBATIM from `Rule`'s own
  fields (FACTORY-844/846) — same names, same validation, same
  "`idlePokeEnabled` always resolves to `true` when absent, the other two
  never resolve" split. Covers group 3 of the epic's three schemas:
  `director`/`advisors`/`admins`/utility sessions (`dialog-monitor`,
  `genius`, `buddy` and equivalents), which run as `SessionDefinition`
  manifests rather than `Rule` resources and so could not share FACTORY-839's
  work directly.
- **Safety question answered with code evidence BEFORE the schema change
  (FACTORY-942 ticket comment):** a poke cannot reach a `SessionDefinition`
  agent today, through any path — unreachable by construction. The idle-poke
  engine's only call site (`src/labels/sync.ts`) is wired exclusively into
  the issue-tier loop and keyed on a Jira issue key (`RuleMatch.issue:
  JiraIssue`, a required field with no SessionDefinition-carrying variant);
  managed sessions run their own separate loop
  (`startManagedSessionsLoop`/`ManagedSessionsLoopDeps`,
  `src/daemon/session-definitions-loop.ts`) which names no `idlePoke`/
  `syncLabels` field at all. So this ticket's job is to make that
  unreachability explicit, configurable and TESTED — not to fix a live gap.
- **Everything shipped here is CONFIG-ONLY / INERT**, same status group 2's
  (`jira-project`) `idlePokeMinutes` already has per FACTORY-842's
  `docs/idle-poke-role-defaults.md`: no engine reads these three fields on a
  `SessionDefinition` yet. Making them live needs a future engine change,
  out of this ticket's scope (the ticket does not widen the engine's reach
  just to make a field live).
- **Shipped per-role values**, documented (not hardcoded in daemon logic —
  this schema has no generic "provision a fresh session-definitions
  directory" mechanism the way `docs/rules.example.json` has for
  `rules.json`, so `docs/codey-session-definitions.example/` — a staged
  migration proxy for one named live fleet — is deliberately left
  unmodified) as worked JSON snippets in the new
  `docs/idle-poke-session-definitions.md`: `director` 1440 min (24h),
  `advisors` 120 (2h), `admins` 240 (4h); `dialog-monitor`/`genius`/`buddy`
  and other utility sessions carry an explicit `idlePokeEnabled: false` —
  the un-pokeable guarantee is this one field, never a code special case.
  `docs/managed-sessions.md`'s own field table gains the three new rows.
- **A regression test for the un-pokeable guarantee**
  (`test/unit/session-definition-idle-poke.test.ts`, FACTORY-926 acceptance
  4): a structural guard pinning that neither `ManagedSessionsLoopDeps` nor
  its `startManagedSessionsLoop({...})` call site in `src/daemon/index.ts`
  ever names `idlePoke`/`syncLabels`, plus a behavioural guard that runs
  `startManagedSessionsLoop` for real against a definition with
  `idlePokeEnabled: true`/a 1-minute `idlePokeMinutes` across many poll
  intervals and asserts `deliver` is never called from idleness alone. Both
  would fail immediately if a future change wired the engine into the
  managed-sessions loop, or bypassed the flag.
- **Rollout note** (FACTORY-926 acceptance 6, `docs/idle-poke-session-definitions.md`'s
  own "Rollout" section): applying this to a live fleet requires an operator
  (or admin-assembly) to hand-edit each live manifest under
  `sessionDefinitionsPath()` — there is no provisioning-from-example path
  for this directory — after upgrading the daemon (an older binary rejects
  the new fields as unknown). Not performed by this ticket: applying the
  config, or restarting/deploying any shared daemon.
