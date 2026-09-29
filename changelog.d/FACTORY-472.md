---
bump: minor
---

### Added

- A herdr-restored pane — after a host hard reset, herdr's own restore mechanism relaunches a workspace's Claude process as a bare `claude --resume <pre-boot-session-id>`, with none of butchr's own launch flags (permission-mode, mcp-config, development-channels, model/effort) — is now relaunched on the SAME session with butchr's full flag set (`HerdrHerd.resumeInPlace()`, the same mechanism FACTORY-312/FACTORY-314 built for a model/effort-only change) instead of being stopped and given a brand-new session. Detected by `isHerdrRestoredPane`: the pane's own observed `--resume <id>` argument matches the workspace's persisted session id — an identity check, not a widened flag-diff allowlist, so it fires regardless of how many of butchr's flags are missing (FACTORY-411/#556's allowlist alone never fires here, since `--mcp-config` is always among the missing flags and is not on that allowlist). A persisted id that's absent or invalidated (FACTORY-418: its transcript is gone, or a fresh launch's discovery poll never completed) still falls through to today's stop-then-fresh-spawn behaviour unchanged, with a comment stating the session was lost and why.

### Fixed

- The `[butchr:resume]` "session preserved" ticket comment no longer implies the relaunch only ever changes model/effort — it now describes reapplying the agent's current launch settings generally, covering both the pre-existing model/effort-only resume and this ticket's full-flag herdr-restore relaunch.
