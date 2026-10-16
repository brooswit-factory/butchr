---
bump: minor
---

### Added

- Dashboard "Sessions" page (epic FACTORY-659, slice D1): lists managed-session definitions (secrets redacted) and edits the allowlisted fields — `modelPower`/`effort` (plain write) and `permissionMode`/`lizardMode` (SERVER-side confirm-gated: an unconfirmed risky edit returns a structured old/new/consequence preview and writes nothing), plus freeze/unfreeze (both freeze gates). Behind the same write guard (Origin/CSRF/same-UID), the shared write rate limit, backup-before-write/atomic-write/audit path, and undo as every other write route. Every other field (`workingDirectory`, `brief`, `mcpServers`, `mcpConfigFile`, and anything else that names a command/path/URL executed at launch) is refused server-side, not merely hidden in the UI — out of scope for this slice.
