bump: minor

### Added

- Setup mode: a fresh install with no Atlassian identity configured no longer crashes
  at startup. The daemon starts serving only `/health`, the dashboard shell, and the
  setup API, prints a one-time setup code (60+ bits, 10-minute TTL, single-use, 5
  attempts) to its own journal, and a fresh code can be minted at any time via
  `SIGUSR2` with no restart.
- `GET /api/setup/status` and `POST /api/setup/jira` (setup mode only): configures the
  Atlassian site/email/token from the dashboard, gated by the setup code, the full
  write-guard chain, and rate limits (5 tests/10 min, 3 writes/hour). The candidate
  token is tested against Jira (`GET /rest/api/3/myself`, redirect refused, 10s
  timeout, fixed-string errors) before anything touches disk.
- `PUT /api/settings/jira/token` (configured mode): rotates the Atlassian token the
  same way, refusing a different Atlassian account than the one already on file, and
  refusing with 409 when the token is provided by the environment rather than this
  daemon's own managed file.
- The token file (`~/.config/butchr/secrets/atlassian-token`) is written atomically
  (0700 dir created only if absent, 0600 temp + fsync + rename, symlink refused, no
  backup copy ever) and its value never appears in a response, audit line, alert,
  error, or log line.
- `ATLASSIAN_SITE` is now validated (at config load, for both the environment and the
  setup/rotation routes) to be exactly `https://<name>.atlassian.net`.
