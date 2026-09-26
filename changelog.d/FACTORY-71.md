bump: minor

### Added
- A managed session that names a Jira project via `linkedEventingProjects` (FACTORY-52) is now actually nudged when that project changes: a member issue update or a change to the project's own managed-link collection (`brooswit.butchr.links`) reaches the session's agent within the normal poll interval, coalesced into one nudge per tick and rate-capped exactly like a `jira-project` rule owner's own linked eventing — the same `runTick` machinery, no second watcher, no separate cap. A frozen session is never nudged. A definition without `linkedEventingProjects` sees no behaviour change.
