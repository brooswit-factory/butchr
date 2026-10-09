bump: minor

### Added
- **"Included in capacity" toggle added to the existing-rule edit dialog (FACTORY-856, story FACTORY-756, epic FACTORY-748).** `RuleEditDialog.tsx` (FACTORY-730's generic edit dialog for any already-created rule) gains the same `role` toggle `FirstRuleSetup.tsx` already shipped — rendered at the rule's current role, following the dialog's own "only send what changed" `buildFieldsPatch` discipline (unlike `FirstRuleSetup`'s always-send), disabled with an explanatory note for `jira-project` rules, and requiring an explicit confirm to turn capacity off (`confirmReason: "capacity-sentinel"`), through the same catalog-validated `PUT /api/rules/:id` path every other field here uses. `docs/execution-modes.md` is updated to drop the now-stale "no existing-rule edit form exists" note.

### Fixed
- Resolved the `main` conflicts left behind once FACTORY-730 (PR #704, server-enforced confirm + dry-run scope for any query edit) landed on `main` ahead of this story's own branch, keeping both sides' behavior: 704's scope/confirm enforcement for query edits, and this story's `role` field (catalog validation, `role: "sentinel"` requiring confirm, `role` not a restart-triggering field).
