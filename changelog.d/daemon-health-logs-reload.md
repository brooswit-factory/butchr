---
bump: minor
---

### Added

- Daemon page in the dashboard (`/daemon`): `/health`'s own build/version/liveness fields, plus a bounded, redacted tail of this daemon's own journal (`GET /api/daemon/logs`, derived from this process's own measured systemd/scheduled-task identity — never a guessed unit name), bounded by both line count and a byte cap, redacted with the project's existing secret-redaction helper. The log route is gated by the same dashboard-origin + same-UID peer guard as every other sensitive dashboard read; an unavailable log source (no systemd unit/task detected, or the read itself failing) is reported as an operator-actionable message, never an empty page.
- A Reload control (`POST /api/daemon/reload`) newly exposes FACTORY-657's existing in-process rules-reload over HTTP, behind the same write-guard chain and shared write rate limit as every other write route; non-destructive (never kills a running agent mid-ticket), so unlike Restart it is not confirm-gated, but every attempt — accepted or refused (e.g. an invalid `rules.json`) — is audited.
- The daemon page also surfaces the EXISTING Restart control (`POST /api/daemon/restart`, already shipped on Settings) rather than a second implementation.
