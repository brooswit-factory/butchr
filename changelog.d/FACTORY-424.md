---
bump: minor
---

### Added

- Resume-in-place (FACTORY-312/FACTORY-314) now generalizes to three more definition fields on a Claude-vendor managed session: `permissionMode`, `strictMcpConfig`, and the `mcpServers` `channel`-flag half. A change confined to one (or a combination) of these, alone or together with model/effort, relaunches the SAME Claude session with the new flags instead of a full stop-then-fresh-spawn — `StaleAgent.resumable` is now set per-reason by a deliberate allowlist (`resumableArgvReason`), never blanket, so every other `checkArgv` reason and every non-Claude provider keep today's fresh-restart behaviour unchanged. An `mcpServers` channel change also gets its `mcp.json` content rebuilt BEFORE the relaunch attempt, not only after, so the relaunched process never reads stale tool bindings on its first post-resume turn. A non-Claude agent hitting one of these three fields now gets a respawn comment that explicitly states the session was lost because resume-in-place is Claude-only by construction, not a bare argv diff with no explanation. Expect exactly one respawn per already-running agent whose argv changes at deploy, not a loop.

### Fixed

- A fresh Claude launch's session-id discovery now invalidates any session id persisted by an earlier launch of the same workspace BEFORE the bounded discovery poll begins, not only in the poll's post-completion failure branch (FACTORY-418) — closing a narrow window where a daemon death or a non-ENOENT filesystem error mid-poll could leave a stale session id (and its still-present transcript) on disk for a later resume to silently pick up and report "preserved".
