bump: patch

### Fixed
- **`bun run typecheck:web` no longer fails at `RuleEditDialog.tsx` under `exactOptionalPropertyTypes` (FACTORY-1002).** Building the rule edit patch explicitly assigned `undefined` to the optional `permissionMode` field (`draftPermissionMode || undefined`), which `exactOptionalPropertyTypes` rejects as TS2412 since the field's type has no `| undefined`. `permissionMode` is now only set on the patch for a nonempty, changed draft value, assigned directly — the same behavior as before (an empty draft already produced no clearable field), just typed correctly.
