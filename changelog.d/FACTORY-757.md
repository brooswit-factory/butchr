bump: minor

### Changed
- **The fleet agent cap no longer special-cases Jira issue type.** Whether
  an agent counts toward `BUTCHR_MAX_AGENTS` is now decided SOLELY by its
  own rule's `role: "worker" | "sentinel"` field (`src/rules/rules.ts`) — the
  same field BUTCHR-398 already shipped. `UNCOUNTED_ISSUE_TYPES`
  (BUTCHR-422/FACTORY-39's hardcoded Epic/Story/Bug exemption) is gone;
  `capacityRoleFor` (`src/agents/capacity-role.ts`) no longer takes an
  `issuetypeOf` lookup at all. One code path now decides capacity for every
  resource provider (`jira-work`, `github-issue`, `github-pr`, `jira-idea`,
  `zendesk-ticket`, `filesystem`) alike — a rule silent on `role` counts
  ("worker"), regardless of what kind of ticket/issue/file it is working.
- This is a deliberate, migration-free behaviour change: an
  `epics`/`stories`/`bugs`-shaped `jira-work` rule that relied on the old
  issue-type exemption now counts toward the cap unless it explicitly sets
  `role: "sentinel"` itself. Two construction-level exceptions survive on
  purpose, documented at `capacityRoleFor`'s own definition: a bare
  project-tier agent (no rule at all backs it) and every `jira-project`
  agent (BUTCHR-425) stay sentinel regardless of their rule's `role`,
  specifically so no live `jira-project` rule needs a config change to keep
  today's behaviour.
- No migration and no UI ship with this change; stored rule config is
  untouched. Docs updated: `docs/execution-modes.md`'s "Fleet capacity
  role" section, `docs/project-agents.md`, and `README.md`'s "Capacity
  naming" paragraph.
