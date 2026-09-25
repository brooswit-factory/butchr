bump: minor

### Added
- `jira-project` joins `RESOURCE_PROVIDERS` on `main` (alongside `jira-work`, `github-issue`, `jira-idea`, `zendesk-ticket`): rule validation, agent-key codec, workspace layout, and MCP identity all recognise it, including a rule's optional `mcpConfigFile` (operator-owned MCP config, `jira-project` only).

### Fixed
- **Capacity:** `capacityRoleFor` now classifies every `jira-project` agent as a `"sentinel"`, unconditionally — never a worker, regardless of its rule's own `role` field (which live rule files never set). These operator-directed project managers no longer consume `BUTCHR_MAX_AGENTS`.
- Reconciled `deploy/project-agents-codex-fallback`'s Codex usage-limit fallback (`nudge()` returns promptly for a Codex pane rather than waiting on Claude's delayed quota-dialog observation — the periodic `recoverQuota` pass reports the refusal instead) and its instance-freeze mechanism with `main`'s current herd, respawn, and admission code — both sides' behavior is preserved.
- A `jira-project` rule loads and runs with every BUTCHR-421 linked-eventing field absent (it never sets them), and with `execution`/`account`/`role` absent (defaulting to `swarm`/`none`/`sentinel`-via-capacity-role, matching Codey's live rule shape exactly).
