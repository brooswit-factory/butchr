---
bump: minor
---

### Added

- **Per-role idle-poke defaults, shipped as config (epic FACTORY-836, story
  FACTORY-839).** `docs/rules.example.json`'s ticket-worker roles now carry
  an explicit `idlePokeMinutes` matching the epic's declared defaults —
  `tasks` 10, `stories` 60 (1h), `epics` 240 (4h); `bugs`/`subtasks` (not
  named by the epic's role list) carry the epic-wide default, 30, explicitly
  rather than being left absent (an absent `idlePokeMinutes` falls back to
  the global `stalledMinutes`, default 10, not the epic's 30 — see
  FACTORY-844/846). A `jira-project` (project/manager) role-default example
  (`idlePokeMinutes: 720`, 12h) is documented in the new
  `docs/idle-poke-role-defaults.md` rather than added to
  `docs/rules.example.json`, which BUTCHR-400 fixes to `jira-work` rules
  only; this value is inert until FACTORY-845 wires a per-rule read into
  `src/agents/pinned-active.ts` (today reads only the global
  `stalledMinutes`). `director`/advisors/admins/utility `SessionDefinition`
  sessions are out of scope for this ticket (tracked separately as
  FACTORY-926) — confirmed by code evidence that no existing poke/stall
  path reaches a `SessionDefinition` agent today at all, so they are off by
  construction. No behaviour change: nothing in the daemon reads
  `idlePokeMinutes`/`idlePokeMessage`/`idlePokeEnabled` yet (FACTORY-845).
