---
bump: patch
---

### Fixed

- Fixed a permanent stranding regression in the resume-in-place mechanism `FACTORY-426` had just made reachable in production (confirmed live: `HandoffBlocked: Current worker disappeared; refusing implicit replacement`, forever, on a genuine band-crossing model/effort change). Root cause: `resumeInPlace` bypasses drovr's `ManagedHerdrLifecycle` entirely (by design, to reuse the same pane), so that class's own private "current worker" bookkeeping is never updated by a resume attempt, success or failure. Once a relaunch collided with `agent_name_taken` — a confirmed-empty pane after `/exit` — the stale bookkeeping caused every subsequent ordinary spawn attempt for that agent to be silently refused, forever, with no error surfaced. `resumeInPlace` now re-checks the pane immediately before returning any non-`"resumed"` outcome from the post-exit region: an empty pane always routes to the same stop-then-spawn fallback an already-safe liveness-check failure used, instead of a bare retry (`"stuck"`) or a propagated throw. The genuinely-still-alive case (the pane never left the old session's foreground) is unaffected.
- Added a dedicated `[resume]` log line for every `resumeInPlace` outcome (including a thrown error) — previously invisible unless a caller happened to wire `onResumePreserved`/`onResumeWaiting`.
