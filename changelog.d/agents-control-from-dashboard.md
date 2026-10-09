---
bump: minor
---

### Added

- Control a fleet worker ticket from the dashboard instead of the CLI/MCP: start, stop, shelve (with a reason) and prioritize, plus adopting an orphan or differently-bossed ticket under a new boss (`POST /api/agents/:issue/{start,stop,shelve,adopt,prioritize}`, `GET /api/agents/:issue` for the panel's own read). Behind the same write guard (Origin/CSRF/same-UID) and write rate limit as every other write-shaped route. Stop and shelve are confirm-gated server-side — a request that omits `confirm` is refused and changes nothing, and the dry-run preview naming what will stop/change rides a structured field on a 200, never parsed out of an error. Every attempt, accepted or refused, is audited; the ordinary unconfirmed preview step is not. "Send text to an agent pane" is deliberately deferred — it injects instructions into a live agent and needs a dedicated safety review first.
