---
bump: major
---

### BREAKING

- **Resource-agent rules replace the issue-type and project tiers.** The daemon no longer staffs every assigned In Progress/In Review ticket by issue type, and no longer runs project agents or the project poll loop. It staffs exactly what enabled rules match: one agent per (rule, matched Jira ticket), stopped when the rule's query stops returning the ticket. There is no compatibility mode and no second loop.
- **Rules come from a config file outside the repo:** `BUTCHR_RULES_FILE`, else `$XDG_CONFIG_HOME/butchr/rules.json`, else `~/.config/butchr/rules.json`. A file whose `rules` array is empty (or all disabled) staffs nothing. When no file exists there are zero rules and nothing is staffed (announced at startup; nothing is written) — there are no built-in default rules or templates. A malformed file stops the daemon at startup with every problem listed.
- **New agent identity and workspace layout.** Agents are keyed `jira-work:<ruleId>:<ISSUE>` and work in `<workspace root>/jira-work/<ruleId>/<ISSUE>`. Legacy `<workspace root>/<ISSUE>` workspaces and their agents are never stopped, adopted, or rewritten (including by `correct_worker`'s summary rewrite). The reaper can still close a leftover herdr workspace at a legacy path once no agent is running there; the directory on disk is kept.
- **MCP identity gains `x-butchr-agent`.** `x-issue` still names the ticket for every tool; rule agents also send their agent key, which scopes channel pushes and own-write echo suppression to the one agent, so two agents on one ticket hear each other's writes.
- **`stand_down` and `check_in` no longer affect staffing.** Both tools still run, but declare nothing; `stand_down` now answers `asleep: false` with a note instead of claiming a sleep and pane release that never happen. Per-agent sleep under rules is not implemented yet.

### Added

- Rule queries read every page of Jira results (`nextPageToken`). A query matching more than 1000 issues, or a response that cannot prove it is complete, fails the whole poll instead of reading the missing tickets as having left the query and stopping their agents.

- Rule schema: `id`, `enabled`, `resourceProvider` (`jira-work`), `query`, `brief`, ranked `agentPreferences` (`harness` claude/codex/agy, optional `model`/`effort` — the first preference naming a harness sets its model and effort), and `relationships` (`childRule`, `inwardConnectionRules`) that reference other rules by id.
- **Rule relationships route worker changes to boss agents (read-only).** An agent under rule `R` on ticket `B` is notified when a ticket `W` changes if some enabled rule matching `W` is `R`'s `childRule` or is listed in `R`'s `inwardConnectionRules`, and Jira already has `W` implementing `B` (an `Implements` link, read from either ticket). A worker never hears its boss; `Relates`/`Blocks` or reversed links, tickets no rule matches, and rules the boss does not name route nothing. A boss hears one change once however many rules match the worker, and a worker agent's own write still reaches its boss. Butchr does not create or edit links.
