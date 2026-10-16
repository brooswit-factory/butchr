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
- The site/email a setup submits are now persisted durably (`~/.config/butchr/
  jira-identity.json`, same atomic/symlink-refusing write discipline as the token
  file) and read back at the NEXT startup alongside the managed token file — a
  restart after a successful setup now actually leaves setup mode, closing the gap
  where only the secret was durable and the daemon would otherwise revert to setup
  mode on every restart.
- A Setup page (shown automatically whenever the daemon is unconfigured) and a Jira
  token-rotation control on the Settings page's connection card, both with
  `autocomplete=off`/cleared-on-submit token fields that are never persisted to
  `localStorage`.
- `scripts/verify-setup-flow-browser.ts`: a real-browser acceptance test driving the
  full flow (unconfigured start, setup code read off the daemon's own journal,
  configure through the UI against a stub Atlassian server, "restart needed" shown,
  then a simulated restart proving `loadConfig` succeeds from the persisted state
  alone).
