# Stalled notifications

Stalled is an inactivity observation, not a failure diagnosis. Working, blocked,
missing, frozen, and removed local agents receive no recurring stalled event.
Done counts as idle. Non-daemon comments reset the Jira inactivity floor to their
timestamp; the detector does not judge their meaning. Failed reads and invalid
comment timestamps cannot prove inactivity. Label stabilization is unchanged.

## Manual configuration

Set a positive finite `stalledMinutes` on the rule whose query selects the agents.
There is no inference from issue type, rank, or link depth. The same value controls
initial detection and each subsequent interval.

| Manually selected group | Minutes |
| --- | ---: |
| Tasks | 10 |
| Stories | 40 |
| Epics | 160 |
| Projects/managers | 640 |
| Director | 2560 |

Issue swarm rules inherit `BUTCHR_STALLED_MINUTES` (default 10) when omitted.
The longest explicit timeout wins when several enabled rules match one ticket.
The rule read API returns null for inheritance; plan/apply accepts null to clear
an override. Singleton/persistent issue rules are rejected because they have no
single-ticket inactivity detector.

Projects prefer `stalledMinutes`, then legacy `idlePokeMinutes`, then the global
value. Managed sessions opt in with `stalledMinutes` in their definition, e.g.
2560 for Director. Omission leaves managed-session stalled detection disabled.
Their status observations and definition edits reset inactivity; these sessions
have no Jira comment channel. No live configuration or enabled state is changed.

## Existing updated-event path

Entry into `agent:stalled` passes label-only suppression. Other daemon label noise
and cleanup remain silent. Existing PR/blocked exceptions remain unchanged.
Self and linked recipients retain the existing routing and delivery functions.

An unchanged Jira label does not create another Jira update. At each due interval,
`withStalledEvents` includes the resource in the existing `changedPrimary` or
`changedRelated` poll result and supplies a `stalled` reason to `decide`. Generic
linked eventing includes the same epoch in its existing coalesced updated-event
payload. There is no artificial Jira timestamp, label toggle, new wake channel,
or periodic Jira comment. Production no longer wires the one-time remediation
and pinned-active comment writers.

While inactivity continues, one epoch occurs at each configured interval forever.
Duplicate polls in that interval stay silent for each recipient. There is no
backoff, hourly stalled-event cap, count-based limit, or escalation. Missed polls
produce one event when polling resumes, without a catch-up burst. Ordinary linked
caps still apply to other updates. Project-member discovery includes active
stalled tickets even after they leave its normal updated-time window.

## Count identity, reset, and persistence

One cumulative informational count belongs to each resource epoch; every recipient
gets that count. Fanout and duplicate polls never increment it. Working, comments,
recovery, removal, and later inactivity episodes reset timing without resetting
the count. Long-lived projects and Director can legitimately accumulate high
counts. Counts measure notification epochs, not confirmed reads or delivery.

Within one daemon, ticket identity is the bare Jira key; project/session identity
is the full existing agent key including rule and resource. Renaming an identity
starts a different count. Counts and last emission times persist atomically in
`stalled-notifications.json` beside the rules file, before the epoch becomes visible.
A write failure blocks the epoch; corrupt state is reported rather than silently
reset. Removed identities are retained. Explicitly removing the state file resets
its counts. Inactivity floors and recipient acknowledgements are process-local;
a restart preserves counts but rebuilds the local inactivity observation floor.

Cross-daemon boundary: epochs are shared only within one daemon. An external
label carries no timeout or count, so another daemon uses its own global timeout,
count file, and observation clock. The label is its remote evidence until cleanup;
local status checks cannot prove a remote agent is running. Fleet-wide identical
epochs, manual timeouts, and counts require shared metadata beyond the unchanged
label. Resolve that architecture decision before claiming fleet-wide parity.

Tests use fake resources/statuses, explicit clocks, and temporary state files.
Runtime delivery requires separately authorized rollout verification; these tests
do not start agents, edit Jira, or restart daemons.
