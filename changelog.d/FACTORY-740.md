bump: minor

### Added
- Silent-stop detector, dry-run only (`src/agents/silent-stop.ts`): when a
  worker's agent transitions from working/blocked to idle/none without a
  self-tagged (`[KEY] `) comment on its own ticket since that episode
  started, logs `[silent-stop] would flag KEY (...)` — no Jira write of any
  kind. Deduplicated per stop. Suppressed for `BUTCHR_SILENT_STOP_SUPPRESS_MINUTES`
  (default 5) after a daemon start or a detected herdr-reconnect gap.
  Controlled by `BUTCHR_SILENT_STOP_MODE` (`off` | `dry-run`, default
  `dry-run`). No enforcing mode yet — FACTORY-736 adds one.
