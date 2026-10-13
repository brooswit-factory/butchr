bump: minor

### Added
- Manual stalledMinutes for Jira issue and project rules, plus opt-in managed-session detection. Repeat stalled notifications at that fixed interval through existing updated-event routing, with a persisted cumulative informational count shared across each daemon's recipients.

### Fixed
- Deliver stalled entry to self and linked watchers without label-echo suppression. Repeats need no label toggles or wake comments and have no backoff or hourly cap. Activity resets inactivity, duplicate polls stay silent, and label cleanup does not wake agents.
