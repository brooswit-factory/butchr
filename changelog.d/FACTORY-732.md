bump: minor

### Added
- A project-scoped Jira allowlist for `jira-project` (manager) MCP callers: `jira_get_issue`, `jira_search`, `jira_add_comment` and `jira_transition`, each confined to the caller's own Jira project (GET-first for the issue tools, JQL-wrapped for search). Every other tool — create/assign/priority/link, `add_link`/`remove_link`, `freeze_session`, Confluence create/update, `set_doc`, every boss/worker verb — stays refused for this caller tier.
