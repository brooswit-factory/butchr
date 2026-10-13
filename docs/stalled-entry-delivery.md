# Stalled episode notices

A Jira ticket receives one visible `[butchr:stall]` comment after continuous inactivity reaches its configured threshold and its stabilized `agent:stalled` label has been read back. Ordinary comment-change delivery informs the ticket's own agent and linked watchers. A label change alone sends no stalled notification, including through the legacy project event path.

The same uninterrupted stall never produces another notice, regardless of elapsed time. Real agent activity or a non-daemon comment resets inactivity; a later qualifying stall can receive one new notice. Daemon notices do not reset the detector. Unknown activity or failed comment reads suppress a write without closing the episode. Failed writes may retry, first checking visible history for a successful prior post.

Existing visible comment history supports adoption after restart or sequential ownership handoff. Overlapping checks within one process are serialized per ticket. There is no repeat scheduler, backoff, stall count, new Jira metadata, or new persistence. As before, a history window that no longer contains the notice cannot prove prior delivery, and the existing single-owner deployment model is required: Jira comment creation has no cross-process compare-and-set guarantee. Working activity occurring entirely while the daemon is offline cannot be reconstructed without visible history.

## Manual thresholds

Set `stalledMinutes` on each supported rule. The manual values 10, 40, 160, 640, and 2560 are accepted as ordinary durations; no role, depth, issue type, or hierarchy chooses them automatically. A missing value inherits the daemon's default. API patches use `null` to remove an override. Overlapping issue rules use the longest explicit value. Disabled or removed rules leave no stale override.

Jira issue thresholds apply to `jira-work` swarm rules. Jira project rules use the existing pinned-active detector, with `stalledMinutes` preferred over its legacy `idlePokeMinutes` override. Project notices retain their existing own-channel behavior. Managed filesystem sessions and query-level singleton/persistent issue agents have no per-ticket comment detector; this change does not invent a channel or enable one. Director/advisor sessions and live configuration are untouched.

The legacy stalled-wake configuration keys and reason type remain accepted for compatibility, but issue/project label transitions no longer produce that event. Ordinary comment routing retains its existing delivery controls.

## Verification

Regression tests exercise a week-long continuous stall, genuine activity followed by a new stall, the notice not rearming its own detector, restart adoption, concurrent polls, unknown reads, failed-write retries, label-only suppression, and ordinary delivery to self plus multiple watchers. Deployment health confirms installed identity only; a natural stall and observed comment/delivery are needed to prove runtime behavior.
