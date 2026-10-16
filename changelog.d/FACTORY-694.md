bump: patch

### Fixed

- `POST /api/settings/jira/test` now checks the body parser's own oversize/invalid-JSON
  sentinels before the rate limiter or the outbound Jira call, refusing outright instead
  of surfacing a 413/400 glued onto a real test result while still burning the limiter
  slot and making the call.
- The connection test's audit event now carries its own `"test"` kind, distinct from a
  config write: a successful test no longer posts a "write ACCEPTED" alert, and a failed
  test alerts immediately under its own label instead of joining the shared rejected-write
  aggregator (which could otherwise bury a real rejected write's own detail).
- `POST /api/settings/jira/test` now requires the upstream 2xx response to carry a JSON
  body with a string `accountId` before reporting `ok: true` — a reverse proxy or captive
  portal answering with its own 200 no longer reads as "connected".
- Each `SETTINGS_DEFINITIONS` entry now carries its own explicit, human-reviewed
  `secret: boolean` instead of one derived from the key's name by regex at runtime, so a
  future key with a secret value and a non-matching name can still be hidden.
- `GET /api/settings`'s unit hint (`systemctl --user show`) is now cached for ~30s instead
  of being re-spawned on every single request.
