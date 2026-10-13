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
