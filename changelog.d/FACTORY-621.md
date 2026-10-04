bump: minor

### Added
- **`butchr rules check [file]` (FACTORY-621, GitHub issue #616).** Validates a rules file with the daemon's own loader (every problem named with its rule and field) and dry-runs each enabled `jira-work`/`jira-idea` rule's JQL against this daemon's configured Jira site, printing per-rule which tickets it would staff (key, status, summary) and flagging plainly when a rule matches more than `BUTCHR_MAX_AGENTS`. Strictly read-only — starts nothing, posts nothing, writes nothing. A new "First run" section in the README walks through writing a first rule scoped to one ticket, checking it, then restarting the daemon; the "no rules file" startup log line now points at it too.
