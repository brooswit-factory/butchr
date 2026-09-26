bump: minor

### Added
- A managed-session definition's `strictMcpConfig` (optional boolean, Claude only): reaches a Claude launch's `ClaudeAgentLaunch.strictMcpConfig` (`@brooswit/drovr` >= 0.14.0), emitting `--strict-mcp-config` alongside `--mcp-config` so Claude Code loads ONLY this agent's own `mcp.json` — no project- or user-level `.mcp.json` discovery on top of it. This is what lets a definition express the Candlestix directors' "permission mode auto with a strict MCP config" faithfully (BUTCHR-391 S7/S5). Complements, does not replace, the existing `assertNoInheritedMcpConfig` guarantee (project-level ancestor `.mcp.json`, unconditional) — `strictMcpConfig` is opt-in and additionally excludes user-level MCP config, which no ancestor-walking check can. Absent/`false`: no flag, today's behaviour exactly.
- `vendor: "codex"` definitions REJECT `strictMcpConfig` at manifest load (any value, not just `true`) — Codex has no equivalent concept, and silently ignoring it (as `permissionMode` does for Codex) would leave an operator believing they have an MCP-isolation property they don't.

### Fixed
- `docs/managed-sessions.md`'s "Nexus's MCP isolation constraint" section corrected a now-stale claim ("this codebase ... never passes `--strict-mcp-config` anywhere") that predated this ticket.
