bump: minor

### Added

- In-daemon watchdog restarts the issue loop's `pollLoop`/`notify` liveness
  components if either stays `stale` for more than
  `BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS` (default 120000ms/2min; bounds-checked
  between 30000 and 1800000ms), the backstop for any never-settling await
  BUTCHR_HERDR_TIMEOUT_MS does not bound. `/health`'s new `loopWatchdog`
  sibling array reports each loop's restart count and last-restart timestamp.
