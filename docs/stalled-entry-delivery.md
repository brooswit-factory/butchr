# Stalled label events

`agent:stalled` is a timer signal, not a diagnosis that an agent is broken.
`StalledTracker` in `src/agents/stalled.ts` requires an uninterrupted idle
streak (`done` maps to idle) lasting `BUTCHR_STALLED_MINUTES`, default 10.
Working, blocked, or no agent resets the streak. A non-`[butchr:` comment
at or after the streak started disqualifies it; an unreadable comment time
also disqualifies it. A failed comment fetch is unknown, and label sync
holds the applied label. The label stabilizer requires two consecutive
observations for a change to an existing label.

Entry into stalled is actionable for the ticket's own agent and every
watcher already admitted by the existing related-resource routing rules.
`createIssueEventRules` checks this entry before own-write and cross-daemon
label-echo suppression. Debounce is per ticket and recipient, so notifying
self or the first boss cannot consume a second recipient's event. The
existing 30-minute default debounce, recent `[butchr:stall]` marker dedup,
and six-per-hour recipient cap remain. A concurrent real comment still
uses ordinary event classification when the stalled wake is debounced.

Generic linked eventing also recognizes stalled entry before its label-only
and own-write filters. It retains per-owner baselines, duplicate-link
deduplication, and the existing linked-turn rate cap. An unchanged poll
does not generate another event. This does not add links, enable disabled
watchers, or broaden discovery.

The exception is entry only. Removing stalled or purging agent labels is
still silent when there is no independent meaningful change. Other label
noise remains suppressed; existing explicit PR and blocked wake rules are
unchanged. This preserves FACTORY-999's silent cleanup contract while
addressing the self/related delivery gap associated with FACTORY-242.

Unit tests use fake Jira data and delivery sinks. Production delivery must
be verified after a separately approved merge and rollout; no test needs
live agents, synthetic Jira edits, or daemon restarts.

## Manual timeout configuration

Set a positive finite `stalledMinutes` on the relevant rule in `rules.json`.
The rule's existing query selects its agents; no issue type, rank, link
depth, or hierarchy is inferred. Configure these accepted starting values
manually when rollout is authorized:

| Configured group | `stalledMinutes` | Duration |
| --- | ---: | --- |
| Tasks | 10 | 10 minutes |
| Stories | 40 | 40 minutes |
| Epics | 160 | 2 hours 40 minutes |
| Projects/managers | 640 | 10 hours 40 minutes |
| Director (follow-on required; see below) | 2560 | 42 hours 40 minutes |

For example, merge `"stalledMinutes": 40` into the existing story rule,
`"stalledMinutes": 160` into the epic rule, and `"stalledMinutes": 640`
into the project-manager rule. Preserve each rule's actual query, id,
enabled state, and all unrelated settings. These are manual values, not
a multiplier or an automatically generated policy. No live config is
changed by this PR.

For Jira issue resource rules, absence inherits `BUTCHR_STALLED_MINUTES`
(default 10). If multiple enabled rules match one ticket, its shared label
uses the longest explicit timeout; rules with no override do not erase an
explicit one. Overrides are rebuilt from the current matches each poll.
The stalled diagnostic logs the effective threshold when it qualifies.
The rules read API returns the configured value, or `null` for inheritance;
the existing rule plan/apply API accepts a positive value or `null` to
remove the override. In the file, remove the property to inherit.

For `jira-project` rules the value sets the existing pinned-active detector
threshold. Explicit `stalledMinutes` takes precedence over the legacy
project-only `idlePokeMinutes` override; that legacy fallback remains for
backward compatibility. These project agents have no Jira issue label.
The new value does not configure recurring poke intervals, debounce,
notification caps, or issue idle-poke timing.

Managed Director/session-definition agents currently have no stalled
detector (`src/resources/session-definition.ts` documents that gap).
The agreed Director target of 2560 minutes is recorded for that focused
follow-on; do not put an unsupported `stalledMinutes` field into a session
manifest or substitute `idlePokeMinutes`. Likewise, query-level
singleton/persistent Jira issue agents do not enter per-ticket label sync.
This PR does not introduce a new detector or activate a stopped Director.
