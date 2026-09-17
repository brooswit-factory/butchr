---
bump: minor
---

### Added

- Resource-agent rules, first slice: a pure `src/rules/rules.ts` module that loads and validates rule configuration from `BUTCHR_RULES_FILE` or `$XDG_CONFIG_HOME/butchr/rules.json`. A rule names a `resourceProvider` (`jira-work` today), a provider-native query, a brief, an `enabled` switch, ranked `agentPreferences` (harness/model/effort), and `relationships` to other rules by id (`childRule`, `inwardConnectionRules`) — no hardcoded role hierarchy. When the file is absent, built-in example rules for epic/story/task/subtask/bug (`src/rules/defaults.ts`) are used in memory and reported as such; nothing is written. Agent identity is a reversible, canonical `<resourceProvider>:<ruleId>:<resourceId>` key, so several rules can each run an agent on the same resource. Not yet wired into the daemon; runtime behaviour is unchanged.
