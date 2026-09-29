bump: minor

### Added
- `GET`/`POST /resources/for-url` now recognises a Jira project or board page (`/jira/software/c/projects/<KEY>/…`, `/jira/software/projects/<KEY>/…`, and the bare `/browse/<KEY>` project home) as a `jira-project:<KEY>` resource, and binds it to the agent a `jira-project` rule staffs for that key. An issue URL (`/browse/<KEY>-<N>`, `.../issues/<KEY>-<N>`, `?selectedIssue=`) is unaffected and still resolves to `jira-work`.
- The dashboard feed (`agent_key` only, via `dashboardAgentOfCwd`) behind `/resources/for-url` and `/agents/:agentKey/pty` now also recognises a `jira-project` agent's workspace (previously silently dropped, the same defect FACTORY-461 documents for github-issue/github-pr/zendesk-ticket/filesystem — this is a deliberately narrow carve-out for `jira-project` only; FACTORY-461 itself is unaffected and still open).
- Label sync and the blocked-dialog escalator stay on `ownsRuleAgent` (jira-work only): a `jira-project` manager pane resolves to no escalation target. Because the same snapshot gates `/agents/:agentKey/pty`, an extension-origin client can now attach to a manager pane; the Origin guard itself is unchanged.
