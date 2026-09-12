bump: minor
### Added
- Ordered default and per-role Claude/Codex preferences with Drovr-owned quota availability and bounded fallback.
- Recover confirmed Claude quota refusals during startup and reconciliation while preserving workspace files.
- Wait without repeated launches when all configured providers are quota-blocked.

### Changed
- Delegate the existing Claude session-limit classifier to Drovr and avoid competing legacy reset recovery for ordered-provider configurations.
