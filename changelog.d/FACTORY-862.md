bump: patch

### Changed

- herdr workspace labels now read `<rule id> · <resource id>` (e.g.
  `jira-work · FACTORY-51`) instead of `<resource id> · <rule id>`, so panes
  group by query when sorted. Running workspaces are relabelled on the next
  daemon start; on-disk workspace directory names are unchanged.
