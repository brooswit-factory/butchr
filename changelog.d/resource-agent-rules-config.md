---
bump: major
---

### BREAKING

- **Resource-agent rules replace the issue-type and project tiers.** The daemon no longer staffs every assigned In Progress/In Review ticket by issue type, and no longer runs project agents or the project poll loop. It staffs exactly what enabled rules match: one agent per (rule, matched Jira ticket), stopped when the rule's query stops returning the ticket. There is no compatibility mode and no second loop.
- **Rules come from a config file outside the repo:** `BUTCHR_RULES_FILE`, else `$XDG_CONFIG_HOME/butchr/rules.json`, else `~/.config/butchr/rules.json`. A file whose `rules` array is empty (or all disabled) staffs nothing. When no file exists, the built-in example rules in `src/rules/defaults.ts` (epic/story/task/subtask/bug, each limited to `assignee = currentUser() AND labels = chop AND statusCategory = "In Progress"`) are used in memory and announced at startup; nothing is written. A malformed file stops the daemon at startup with every problem listed.
- **New agent identity and workspace layout.** Agents are keyed `jira-work:<ruleId>:<ISSUE>` and work in `<workspace root>/jira-work/<ruleId>/<ISSUE>`. Legacy `<workspace root>/<ISSUE>` workspaces and their agents are never stopped, adopted, reaped, or rewritten (including by `correct_worker`'s summary rewrite).
- **MCP identity gains `x-butchr-agent`.** `x-issue` still names the ticket for every tool; rule agents also send their agent key, which scopes channel pushes and own-write echo suppression to the one agent, so two agents on one ticket hear each other's writes.
- **`stand_down` and `check_in` no longer affect staffing.** Both tools still run, in their existing "declares nothing" mode; per-agent sleep under rules is not implemented yet.

### Added

- Rule schema: `id`, `enabled`, `resourceProvider` (`jira-work`), `query`, `brief`, ranked `agentPreferences` (`harness` claude/codex/agy, optional `model`/`effort` — the first preference naming a harness sets its model and effort), and `relationships` (`childRule`, `inwardConnectionRules`) that reference other rules by id. Relationships are validated but not yet acted on.
