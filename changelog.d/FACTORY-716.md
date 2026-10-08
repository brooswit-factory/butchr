bump: patch

### Fixed
- Fresh install: the first-run starter rule is now seeded even after UI
  setup has written its own state (the Jira identity file, the managed
  token's `secrets/` directory, and the write-audit log) into the config
  directory — FACTORY-685's "absent or genuinely empty" check no longer
  reads that setup-written state as an established install configured some
  other way. The misleading "add a rules file by hand" startup guidance no
  longer appears on this path.
