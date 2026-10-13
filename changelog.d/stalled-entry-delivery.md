bump: minor

### Added
- Manual stalledMinutes thresholds for Jira issue and project rules, independent of idle pokes and hierarchy.

### Fixed
- Post one visible comment per verified stalled episode. Staying stalled produces no further comments; real activity can enable a later episode. Deliver the comment through ordinary self and linked-watcher routes, and keep stalled label-only changes silent.
