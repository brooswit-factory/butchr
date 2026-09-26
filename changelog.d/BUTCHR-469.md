bump: minor

### Added

- `jira-project` rules that opt into `linkedEventing` get a per-project
  member-discovery watch (`project = <key> AND updated >= <watermark>`) and
  change/comment events for the project's managed links
  (`brooswit.butchr.links`), coalesced into the same rate-capped nudge as
  every other linked-eventing owner. A rule without the linked-eventing
  fields is unaffected.
