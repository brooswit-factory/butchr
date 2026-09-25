bump: minor

### Added
- A well-known managed-session definitions directory (`BUTCHR_SESSION_DEFINITIONS_DIR`, else `$XDG_CONFIG_HOME/butchr/session-definitions`) and a validated JSON manifest format — working directory, brief, vendor (Claude/Codex), model tier, permission mode, and reused `execution`/`account`/`role` fields — for expressing Bakr directory agents and Candlestix sessions as ordinary Butchr-managed agents.
- A built-in `filesystem`-provider query, shipped by Butchr itself (never read from `rules.json`), that keeps exactly one agent per eligible (valid, not frozen) definition file; an invalid or frozen definition is skipped and logged, never silently staffed or dropped.
- `SpawnSpec.cwd` and `SpawnSpec.permissionMode` (both optional, additive): a managed session's own working directory reaches its agent through its kickoff instructions (told to `cd` there before doing anything else — the process itself still launches at the ordinary bookkeeping workspace, see "Fixed" below for why), and its permission mode reaches a Claude launch.
- `docs/managed-sessions.md`.

### Not yet included
- MCP server list / channel bindings on a definition — deferred pending BUTCHR-395/BUTCHR-411's `Rule.mcpServers` shape landing and a sequencing decision.

### Fixed
- Tiers are now `tier1`-`tier5`, and `tierToModel(vendor, tier)` uses the real Candlestix `model-tiers.json` table (ported per CNDLX-45 comment 23525, relayed on BUTCHR-408) instead of the earlier provisional `tier0`-`tier2` guess — model choice depends on vendor as well as tier (Claude: sonnet/opus; Codex: gpt-5.6-luna/terra/sol, gpt-6-astra).
- PR #394 review: a definition's `role: "sentinel"` now actually exempts its agent from the fleet-capacity admission cap (previously validated/stored but never read by the classifier — every managed-session agent silently counted as `"worker"`).
- PR #394 review: `SpawnSpec.cwd` no longer redirects butchr's own bookkeeping files (CLAUDE.md/AGENTS.md/mcp.json/ENVIRONMENT.md) into the operator's own working directory — it only overrides the spawned PROCESS's cwd. Bookkeeping files always land in the ordinary `workspaceDirFor` tree, so a Bakr agent's own project files are never overwritten.
- PR #394 review: a missing well-known definitions directory (the common case — most daemons won't have one) no longer fails the poll every 15s; it's treated as zero definitions, same as a missing `rules.json`. A directory that exists but is unreadable or not a directory still fails loudly.
- PR #394 review (round 3): a `cwd`-bearing spec could not actually spawn at all through the real `HerdrHerd`/Drovr path — `ManagedHerdrLifecycle` hard-requires the launched process's `cwd` to equal its own fixed workspace `cwd`, and `HerdrHerd.runningIssues()` cannot see a pane outside the ordinary `workspaceDirFor` layout at all. The launched process now always stays at the bookkeeping directory; the definition's `workingDirectory` reaches the agent through its own kickoff instructions instead (`cd` there, then follow the brief).
