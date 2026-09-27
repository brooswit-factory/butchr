---
bump: minor
---

### Added

- `lizardMode` now works for `vendor: "codex"` managed-session definitions and rule-launched Codex agents (FACTORY-108, drovr >= 0.16.0): a Codex agent no longer needs `--dangerously-bypass-approvals-and-sandbox` to get an unattended, approve-once answer to a command/edit/MCP-tool approval dialog — the daemon's permission-answer loop now also calls drovr's `autoAnswerCodexApprovals` on both the event-driven and 20s-sweep paths, scoped to the same lizard-eligible panes as the existing Claude pass (a Claude pane is never touched by the Codex pass and vice versa). An EXPLICIT `lizardMode: true` on a `vendor: "codex"` definition or rule is what drops the bypass flag at launch (unset/explicit-`false` launch unchanged; a default-`true` ELIGIBILITY resolution never changes launch argv) — see `docs/managed-sessions.md`'s and `docs/permission-answer-loop.md`'s "Codex support" sections for the fixture-coupling caveat, the recognised prompt surface, the toggle-on-a-running-agent asymmetry, and the host-config caveat.
- `SessionDefinition.lizardMode`/`Rule.lizardMode` no longer reject `vendor: "codex"` at manifest load (only `strictMcpConfig` still does, unchanged, unrelated).
- No stale-argv respawn loop for a lizard Codex agent: `SpawnSpec.lizardMode` is persisted at spawn (`.butchr-lizard-mode.json`) and read back by `HerdrHerd.staleIssues()`, the same FACTORY-43 shape `permissionMode`/`strictMcpConfig` already have.

### Changed

- `@brooswit/drovr` pinned to v0.16.0 (Codex lizard support) — a later combined release will replace this pin once announced on FACTORY-106/FACTORY-128.
