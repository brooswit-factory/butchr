---
bump: minor
---

### Added

- `BUTCHR_RESTORED_RESUME` canary/kill switch for herdr-restored-pane resume-in-place (FACTORY-470/472): `off` disables it fleet-wide (today's allowlist/stop+spawn behaviour, unconditionally); `all` enables it for every managed session; a comma-separated list enables it only for the named managed sessions (their bare definition name, e.g. `buddy`). Unset defaults to `buddy,genius` — the epic's own reading of an ambiguous director steer, stated in this PR's description so it can be corrected in one line. An ordinary (non-managed-session) task/story/epic agent has no stable name to gate on, so only the `all` policy ever reaches it.
- `isHerdrRestoredPane`'s `--resume` argv parsing now also accepts the `--resume=<id>` and short `-r`/`-r=<id>` forms, not just the separate-argument `--resume <id>` form herdr's own measured restore shape actually produces — defensive hardening against a future launcher/herdr change, not a fix for a currently-broken case.
- Every restored-pane classification now logs the observed argv under a new `[herdr-restore]` tag, so a future silent no-op in the argv parsing is diagnosable from the journal alone.
- A pane whose claude launch is still pending (herdr's `launch_pending: true`, no `agent_session` registered yet) is never classified as herdr-restored, even when its argv already carries a `--resume` matching the persisted session id — closes a hazard where an in-flight butchr-owned launch could be misread as a herdr restore.
- `resumeInPlace()`'s `"failed"` outcome now closes the pane by id directly, inside the method itself, before returning — defence in depth alongside `reconcileNow`'s own identity-matched `herd.stop()` in the fallthrough, since real herdr removes a bare-shell pane's `agent.list()` entry entirely once it's confirmed empty (so that identity match may have nothing left to find by the time the fallthrough runs).

### Fixed

- `isHerdrRestoredPane`'s discriminator now requires ALL THREE of butchr's own launch flags (`--permission-mode`, `--mcp-config`, `--dangerously-load-development-channels`) absent, not just `--mcp-config` — a pane missing only `--mcp-config` while still carrying one of the other two was previously (incorrectly) eligible for the identity match.
- `test/unit/herd.test.ts`'s `statefulHerdr` fixture now REMOVES a pane's `agent.list()` entry when its foreground goes to shell, matching real herdr's own measured behaviour (a bare-shell pane's entry is absent, never present with `agent: undefined`) — the previous shape was what produced (and then had to withdraw) a "state 3" prediction that does not exist in reality.
