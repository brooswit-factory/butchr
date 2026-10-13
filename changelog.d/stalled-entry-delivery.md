bump: minor

### Added
- Manual stalledMinutes for Jira issue and project rules, plus opt-in managed-session detection. Repeat stalled updates at a fixed interval through existing event routing with in-memory per-recipient deduplication.

### Fixed
- Deliver stalled entry to self and linked watchers without label-echo suppression. Local repeats need no label toggles or wake comments and have no backoff or hourly cap. Activity resets inactivity, duplicate polls stay silent, and label cleanup does not wake agents.
