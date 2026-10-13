bump: minor

### Added
- Manual per-rule `stalledMinutes` overrides for Jira issue stalled detection and project-manager pinned-active detection, independently configurable from idle pokes. Omission preserves existing defaults; configuration patches can clear an override back to inheritance.

### Fixed
- Deliver entry into `agent:stalled` to the ticket's own agent and every routed related watcher without swallowing it as a daemon label echo or letting the first recipient consume the others' event. Linked eventing also recognizes stalled entry. Preserve delivery limits, repeated-poll deduplication, and silent label cleanup/removal.
