bump: minor

### Added
- A managed session that names a Jira project via `linkedEventingProjects` (FACTORY-52) is now actually nudged when that project changes: a member issue update or a change to the project's own managed-link collection (`brooswit.butchr.links`) reaches the session's agent within the normal poll interval, coalesced into one nudge per tick — reusing the SAME `runTick` machinery a `jira-project` rule owner's own linked eventing already uses, no second watcher. A frozen session is never nudged. A definition without `linkedEventingProjects` sees no behaviour change. Known gap (FACTORY-78): as with an unconfigured `jira-project` rule owner, these nudges are uncapped by default — a managed-session definition has no field yet to configure a rate cap.
