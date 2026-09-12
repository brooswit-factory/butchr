bump: minor

### Added

- Select Claude (default) or Codex for new agents with BUTCHR_AGENT_PROVIDER,
  optionally overriding the model with BUTCHR_AGENT_MODEL. Codex gets AGENTS.md,
  native CLI flags and isolated HTTP MCP configuration. Existing providers
  remain recognized by argv health, residency and reaper checks.
- Codex updates use Herdr prompts; Claude channel notifications exclude Codex.
  Inherited MCP servers are disabled without modifying global configuration.
