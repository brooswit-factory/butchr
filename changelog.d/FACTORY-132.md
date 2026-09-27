---
bump: minor
---

### Fixed

- **The Configurations view (`/configurations`, `/config-inventory`) claimed a rule was `UNSTAFFED` — and its cross-link area said "no running agent" — in the one situation where the daemon cannot know either: when the agent census (the poll-fed `agent.list()` snapshot behind `/dashboard`) is unavailable (FACTORY-121/FACTORY-132).** The pre-existing agents view (`/`) already renders a distinct "COULD NOT CHECK" banner for this same unknown (keyed on `DashboardResponse.checked === false`); the Configurations view now honours the same distinction per-row instead of collapsing the unknown into a false "not staffed" or "no running agent". `RuleInventoryEntry.staffed` widens from `boolean` to `boolean | null` (`null` = could not be determined this poll, distinct from `false` = genuinely not staffed); every in-repo reader compares with `=== true`/`=== false`/`=== null` rather than a truthiness test, so the unknown state can never silently collapse back into "not staffed" again. `RenderConfigInventoryOpts` gains a required `agentCensusChecked: boolean`, sourced from the same `/dashboard` snapshot already used for cross-link matching, so a caller can no longer wire this up wrong without a compile error.
- Genuinely-unstaffed cases (disabled rule, provider config/credential reason, admission cap, an observed real zero) are unchanged and still render `UNSTAFFED: <reason>` regardless of census state, since those are config/observation facts, not census facts.
