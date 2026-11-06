bump: patch

### Fixed
- `resumeInPlace`'s `launchPending` deferral no longer persists forever for a pane stuck in herdr's unbounded Blocked phase (FACTORY-1037). Past `LAUNCH_PENDING_STUCK_TIMEOUT_MS` (5 minutes, well above herdr's own documented 300s Pending-phase cap) for the SAME pane, `resumeInPlaceExclusive` now reports `"stuck"` instead of `"deferred"` — the existing non-destructive outcome, never a relaunch or a kill — so a launch that never actually started (a native shell-readiness race truncating the injected command, confirmed live) eventually surfaces instead of silently waiting indefinitely.
