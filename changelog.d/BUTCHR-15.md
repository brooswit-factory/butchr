bump: minor

### Added
- `effortFor(issuetype)` in `src/agents/workspace.ts`, mirroring `modelFor()`: a single map deciding the `--effort` level passed to newly spawned agents. Current defaults: epic = high, story = high, task = high, and unknown issue types also default to high.
- `spawnArgs` now emits `--effort <level>` alongside `--model <level>` in every agent's spawn argv.
- `--effort` is excluded from `REQUIRED_FLAGS` (the argv staleness check), same as `--model` and the kickoff positional: changing `effortFor()`'s defaults will not make already-running agents read as stale and get respawned.

This is a spawn-arg change only — it takes effect for agents spawned after this ships. Agents already running keep the argv they were spawned with until they are individually respawned; there is no automatic fleet-wide restart.
