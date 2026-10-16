---
bump: minor
---

### Added

- Create a new rule from the Rules page (`POST /api/rules`): operator sets id, resource type, query, and optionally a preferred agent, permission mode, lizard mode and capacity role. Behind the same write guard (Origin/CSRF/same-UID), write rate limit, backup-before-write/atomic-write/audit path, and undo as every other rules write. The id must not already exist. Confirm is mandatory on every create and the refusal names the dry-run scope of the query. The new rule is always created disabled.
