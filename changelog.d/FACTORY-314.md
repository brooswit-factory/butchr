---
bump: minor
---

### Added

- A model/effort-only change on a running Claude agent (FACTORY-312/FACTORY-314) now resumes the SAME conversation on the SAME pane instead of stopping and starting a fresh session: `HerdrHerd.resumeInPlace()` waits for the agent to be idle (never interrupts a turn), asks it to exit, confirms its pane returned to a shell, then relaunches with `--resume <session-id>` plus the new model/effort and every other launch flag. Every Claude launch now mints and persists its own native session id (`.butchr-session-id.json`) for this purpose. The ticket comment distinguishes a preserved resume (`[butchr:resume]`, never "re-read your ticket") from a genuine loss (`[butchr:respawn]`, unchanged wording plus an honest "session id could not be determined" reason for the one-time gap on agents from before this change). Every other stale-argv reason, and every non-Claude provider, keeps today's stop-then-fresh-spawn behaviour unchanged. Expect exactly one fresh respawn per already-running Claude agent the first time it needs a resume after this deploys (no persisted session id yet).

### Fixed

- The stale-argv reconcile comment no longer tells an agent whose conversation was actually preserved to "re-read your ticket as if fresh".
