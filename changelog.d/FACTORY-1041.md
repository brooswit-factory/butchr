bump: patch

### Fixed
- `HerdrHerd`'s two direct `startManagedAgent` call sites (`tryClaudeResume`, `resumeInPlaceExclusive`) now accept a `checkCanonicalMode` test-injection seam, mirroring the existing `monotonicNow`/`wait` pattern (FACTORY-1041). The pinned `@brooswit/drovr` commit predates drovr's pre-launch TTY-readiness gate (drovr PR #100) and silently ignores this option today, but `test/unit/herd.test.ts`'s fixtures now provide `shell_pid` on every pane this launch path exercises, so they stay passing once the pin advances past that gate instead of hitting the same fixture gap FACTORY-1037 hit on the drovr side.
