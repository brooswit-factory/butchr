bump: patch

### Fixed
- Reworded a stale doc comment on `WriteRulesIo.acquireLock` that still promised a "stale-lock reclaim protocol" (removed in FACTORY-673/#646); it now describes the real fail-closed behaviour. Raised the two-OS-process "neither proceeds" race test from 25 to 200 iterations, as the required proof that the rename-based reclaim race is gone. Comments and test iteration count only — no behaviour change.
