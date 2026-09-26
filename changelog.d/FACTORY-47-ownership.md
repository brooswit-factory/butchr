bump: patch

### Fixed

- Managed-session agents no longer die about every 12 seconds. The ordinary
  filesystem loop claimed them as its own and stopped them as leftovers while
  the managed-sessions loop respawned them. Each loop now owns only its own
  agents (FACTORY-47).
