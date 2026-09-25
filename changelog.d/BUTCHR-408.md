bump: minor

### Added
- A well-known managed-session definitions directory (`BUTCHR_SESSION_DEFINITIONS_DIR`, else `$XDG_CONFIG_HOME/butchr/session-definitions`) and a validated JSON manifest format — working directory, brief, vendor (Claude/Codex), model tier, permission mode, and reused `execution`/`account`/`role` fields — for expressing Bakr directory agents and Candlestix sessions as ordinary Butchr-managed agents.
- A built-in `filesystem`-provider query, shipped by Butchr itself (never read from `rules.json`), that keeps exactly one agent per eligible (valid, not frozen) definition file; an invalid or frozen definition is skipped and logged, never silently staffed or dropped.
- `SpawnSpec.cwd` and `SpawnSpec.permissionMode` (both optional, additive) so a managed session's own working directory becomes its spawned agent's real process `cwd`, and its permission mode reaches a Claude launch.
- `docs/managed-sessions.md`.

### Not yet included
- MCP server list / channel bindings on a definition — deferred pending BUTCHR-395/BUTCHR-411's `Rule.mcpServers` shape landing and a sequencing decision.
- A managed-session agent's own `role` is not yet read by the fleet-capacity admission classifier (rule-level only today); the field is validated and stored.

### Fixed
- Tiers are now `tier1`-`tier5`, and `tierToModel(vendor, tier)` uses the real Candlestix `model-tiers.json` table (ported per CNDLX-45 comment 23525, relayed on BUTCHR-408) instead of the earlier provisional `tier0`-`tier2` guess — model choice depends on vendor as well as tier (Claude: sonnet/opus; Codex: gpt-5.6-luna/terra/sol, gpt-6-astra).
