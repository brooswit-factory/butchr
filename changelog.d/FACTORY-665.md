bump: minor

### Added

- `~/.config/butchr/settings.json`: a non-secret layer of defaults, strictly under the
  environment, for a small allowlist (`BUTCHR_MAX_AGENTS`, `BUTCHR_AGENT_PROVIDER(S)*`,
  `BUTCHR_AGENT_MODEL`, `BUTCHR_POLL_STALE_MS`) — no path/URL/identity/port/rules-file
  key, and never a secret. Range-checked (a poll-staleness floor; a fleet-cap ceiling
  requiring `confirm: true` to cross) and refused LOUDLY (journal line + ops alert, the
  key simply unset, never a silent default) on invalid JSON, a wrong owner, a symlink,
  or a mode wider than 0600.
- `PUT /api/settings/:key` writes one allowlisted key through the same validated,
  locked, atomic, backed-up write path `rules.json` already uses (full write-guard
  chain, write-flood rate limit, audit + alert). The Settings page now shows an edit
  control for every allowlisted row (current value, source — environment/file/default
  — and a restart-needed badge) alongside the existing read-only rows.
- `POST /api/daemon/restart`: fires `systemctl --user restart butchr.service` (fixed
  argv, no interpolation) only when this daemon is actually running under that unit;
  409 otherwise. Full write-guard chain, explicit `confirm: true`, its own 1-per-10-minute
  rate limit, audit + alert. A restart button on the Settings page, with a confirm
  dialog and a reconnect-with-backoff status while the daemon is down.

This is PR-1 of 2 for FACTORY-665 (epic FACTORY-659, slice S2). PR-2 (setup mode + the
Jira token endpoint) is separate and not included here.
