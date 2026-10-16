bump: minor

### Added
- **Upgrade migration for the pre-FACTORY-757 issue-type capacity exemption.**
  FACTORY-757 deleted `UNCOUNTED_ISSUE_TYPES` (the hardcoded Epic/Story/Bug
  exemption, `src/agents/capacity-role.ts`) and shipped deliberately
  migration-free (`changelog.d/FACTORY-757.md`: "No migration and no UI
  ship with this change"). A new startup-time migration
  (`src/rules/capacity-role-migration.ts`, wired into `src/daemon/index.ts`
  right before `loadRules` reads the file for real, same convention
  `src/rules/seed-first-run.ts` already uses) now writes `role: "sentinel"`
  onto exactly the `jira-work` rules whose JQL relied on that deleted
  exemption, so an existing deploy's fleet agent count stays exactly what
  it was before the upgrade, until an operator changes it.
- The migration recognises a rule's issue-type restriction from its JQL
  itself (`classifyJqlQuery`) — a single, top-level, AND-ed, non-negated
  `issuetype = X` / `issuetype IN (X, Y, …)` clause whose named type(s) are
  a subset of `{Epic, Story, Bug}` — and deliberately refuses to guess
  about anything looser (zero or multiple such clauses, an OR-combined
  clause, a negated operator, unbalanced parens/quotes): those are left
  untouched and logged at startup, never guessed in either direction.
- Idempotent and existence-based, the same discipline
  `src/agents/workspace-migration.ts` already established: a rule that
  already carries an explicit `role` (operator-set, or written by the
  epic's own interim admin-assembly mitigation) is never reclassified or
  overwritten, and a run with nothing to migrate performs zero filesystem
  writes (no new backup, no touched mtime) — a true no-op, not merely a
  written-but-unchanged file. The write itself goes through a new
  `setRuleRole` (`src/rules/write-rules.ts`), the `role`-field twin of the
  existing `setRuleEnabled` surgical text editor, so every other rule,
  field, and byte of file formatting survives untouched.
- `jira-project` (manager) rules, bare project-tier ids, and non-Jira
  (`github-issue`/`github-pr`/`zendesk-ticket`/`filesystem`) rules are
  never even classified by this migration — the first two are sentinel by
  construction (their `role` is never read by `capacityRoleFor`), and the
  pre-FACTORY-757 exemption never covered the others, so none of them need
  any config written.
- Docs updated: `docs/execution-modes.md`'s new "Upgrade migration" section
  (right after "Fleet capacity role"), `docs/project-agents.md`, and
  `README.md`'s "Capacity naming" paragraph all now state plainly that
  capacity inclusion is an explicit per-rule choice an operator is expected
  to set on any NEW rule, with this migration only ever backfilling
  EXISTING rules once, automatically.
