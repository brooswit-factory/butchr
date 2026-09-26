bump: minor

### Added
- `freezeControllers`/`unfreezeControllers`, two optional fields on a managed-session definition naming OTHER definitions (by file name) whose agent may delegate freeze/unfreeze control of this one — validated through the same schema validator every other field goes through, and independent of each other by design (a name in one grants nothing on the other).
- `freeze_session`/`unfreeze_session`, two new butchr MCP tools that call the existing `freezeSessionDefinition`/`unfreezeSessionDefinition` core (BUTCHR-454) unchanged, authorized entirely from the caller's own daemon-derived MCP identity (never from a tool argument) against the target definition's grant. Every refusal (unknown name, invalid target, no grant, non-managed-session caller) reads identically, so a probing caller learns nothing about which definitions exist. Available to both `vendor: claude` and `vendor: codex` managed-session agents.
- `butchr session create --freeze-controllers`/`--unfreeze-controllers` to set the new grant fields at creation; `list`/`show` display them.
