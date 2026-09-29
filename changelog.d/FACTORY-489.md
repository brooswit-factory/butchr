---
bump: patch
---

### Fixed

- `resumeInPlace()` no longer sends `/exit` to a pane whose claude launch is still pending (herdr's `launch_pending: true`): `agent_status` is computed from screen state independently of the managed-agent launch phase, so a launch-pending pane can briefly report `"idle"`/`"done"` — a state the existing idle check alone would treat as safe to resume. `resumeInPlace()` now defers instead, checked right after the existing provider check (so a pane whose claude process has already exited still gets the ordinary `"unresumable"` -> stop()/spawn() recovery) and before the idle check.
