bump: minor

### Added
- Bumped the pinned `@brooswit/drovr` SDK commit to a reconciliation of its two previously-diverged lines: the approved staged-handoff target-name work (`stagedTargetName`/`historyMode`/`requiresInspection`, drovr PR #99 — butchr's prior pin) merged onto drovr `main`'s own tip (drovr PR #102 / v0.16.14), which carries FACTORY-1037's pre-launch TTY-readiness gate (`checkCanonicalMode`) and FACTORY-1044's GitHub-consent-dialog recognition that the old pin lacked (FACTORY-1041). `HerdrHerd`'s direct `startManagedAgent` call sites (`tryClaudeResume`, `resumeInPlaceExclusive`) and its `ManagedHerdrLifecycle`-mediated spawn path now all route through the same, newly-live readiness gate.

### Fixed
- `HerdrHerd` gained a `checkCanonicalMode` test-injection seam (new optional constructor field, mirroring the existing `monotonicNow`/`wait` pattern), threaded into every `startManagedAgent` call site via a shared `claudeLaunchOptions()` helper and `lifecycle()`'s own `startOptions`. A new suite-wide test preload (`test/setup/drovr-canonical-mode-gate.ts`) supplies a safe default so none of the test suite's fake herdr clients trip the real gate's 5-second readiness bound.
