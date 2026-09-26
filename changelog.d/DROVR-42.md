bump: minor

### Added
- **The daemon now auto-answers unattended tool-permission prompts on its own timer.** A new standalone poll (every 20s, independent of the Jira reconcile loop and the blocking-escalation watcher) calls `@brooswit/drovr`'s `autoAnswerPermissions` across every Claude pane butchr hosts, pressing the "Yes, and always allow …" stored-rule option only when it is unambiguously that option — the same prompt that previously left an agent frozen for hours until a human noticed (the DROVR-37 incident). Every attempt is recorded to a JSONL audit log under the workspace root (`.permission-audit.jsonl`, `BUTCHR_PERMISSION_AUDIT_PATH` overrides), operator `butchr-daemon`. See `docs/permission-answer-loop.md` for the cadence justification and how to inspect recent auto-answers.
