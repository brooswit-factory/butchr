bump: patch

### Fixed
- **A stale `fastPathTriggers` entry for a pane that left the permission-answer loop's eligible set could re-trip the watchdog forever, and the watchdog's forced in-flight reset could race a late-settling wedged tick into running two answer passes concurrently (FACTORY-749).**
- `runPermissionAnswerTick` now reaps every `fastPathTriggers` entry for a pane outside the current tick's eligible set as soon as that tick runs — covering the `labels.size === 0` early return, a pane that simply left the eligible set, and the outer `catch` for a rejecting `agent.list()` call alike. A watchdog trip also clears exactly the entries it fired on, so a genuine stall is still force-restarted but never re-trips on the same stale entry every `watchdogCheckIntervalMs` once the loop is healthy again.
- A separate tick-generation counter (distinct from the existing subscription `generation`) is bumped whenever the watchdog forces a reset, so a wedged tick's own late `.finally()` becomes a no-op instead of clearing `inFlight` out from under the fresh tick the watchdog already started — closing the window that let a third tick start concurrently with it.
- Updated the doc comments on `watchdogThresholdMs` and the module header that asserted a surviving `fastPathTriggers` entry, or tick concurrency, could never happen — both claims were false before this fix and are now accurate.
- The existing "a tick stuck forever on an unresolving herdr call is force-restarted" test is unmodified and still passes.
