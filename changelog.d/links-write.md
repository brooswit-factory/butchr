---
bump: minor
---

### Added

- Dashboard "Links" page (epic FACTORY-659, slice D1 follow-up): lists the butchr-managed link collection (the same one `butchr link` edits) and adds/removes entries. Behind the same write guard (Origin/CSRF/same-UID), the shared write rate limit, backup-before-write/atomic-write/audit path, and undo as every other write route in this daemon — new for this collection, which previously only had a plain, unbacked-up `writeFileSync`. Reuses `../resources/link-store.ts`'s own `addLink`/`removeLink` validation and idempotency rules (self-links refused, an already-present/absent link is a no-op, never a write). Scoped to the FILE-backed link store only: a `jira-project:`-owned resource's links live in a Jira project property instead and are refused server-side from this route (403) — `butchr link` on the CLI still reaches that store as before.
