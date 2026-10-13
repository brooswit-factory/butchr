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

## Recurrence boundary

The scheduler has only in-memory interval and recipient-deduplication state.
There is no notice count, persistence file, ticket property, or hidden Jira
metadata. Restarting resets scheduling observations.

On another daemon, an unchanged external label supplies neither the source
rule's manual timeout nor a new event for a repeat. This implementation uses the
watcher's local global timeout for such external observations; it does not provide
fleet-synchronized recurrence. This boundary remains unresolved before merge.

The minimal fleet-wide alternative is a human-visible ordinary stall comment
from the owning daemon once per source-configured interval. Existing comment
change detection would route it to self and linked watchers without new metadata
or transport. That alternative has not been implemented or deployed.

Tests use fake resources/statuses and explicit clocks. No tests start agents,
edit Jira, or restart daemons. Counts are explicitly deferred.
