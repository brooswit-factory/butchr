bump: minor

### Added

- A `jira-project` rule's manager now wakes when any ticket in one of its
  matched projects transitions into `agent:blocked` or `agent:stalled`
  (project-wide, orphan tasks included) — the same debounce, hourly cap, and
  `[butchr:blocked]`/`[butchr:stall]` marker dedupe `createProjectEventRules`
  already established for the `ProjectResource` tier, wired for the first
  time into the live `jira-project` rule type (`createJiraProjectResourceType`).
  Debounce/cap values are threaded from the daemon's existing global config
  (`blockedWakeDebounceMinutes`, `stalledWakeDebounceMinutes`,
  `stalledWakeMaxPerHour`) — no second config surface.
