bump: patch

### Changed
- Bump `@brooswit/drovr` to 0.16.2 (FACTORY-320/FACTORY-326): carries FACTORY-318's no-stored-rule permission-dialog escalation fix, Codex lizard mode, `AskUserQuestion` dialog recognition, and the bundled approval-sound asset. `createBlockingEscalationWatcher` now takes a required second argument; the call site (`src/agents/managed-session-escalation-watcher.ts`) passes `{ permissionScope: "once" }`, matching the scope butchr's own answering pass (`src/agents/permission-answer-loop.ts`) already uses, so this is a compile-compatibility update with no behavior change for butchr: under scope `"once"` this dialog shape was already answerable before FACTORY-318's fix.
