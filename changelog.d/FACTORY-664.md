bump: minor

### Added

- A read-only Settings page in the dashboard app: every setting butchr reads from the
  environment (key, value or source, restart-needed badge), with secrets (TOKEN/SECRET/
  PASSWORD/KEY-matching names) shown only as set/unset, never their value.
- A Jira connection card showing the configured site/email and the Atlassian token
  file's own path/existence/readability/permissions (warning when wider than 0600, never
  its contents), with a Test connection button backed by `POST /api/settings/jira/test`
  (rate-limited, audited, and reporting only a fixed ok/site/httpStatusClass shape —
  never the upstream response body or the credential itself).
- `GET /api/settings`, guarded by the same dashboard-origin + same-UID peer check as
  `GET /api/rules`, plus a best-effort `unitHint` naming the systemd drop-in/EnvironmentFile
  this daemon's environment actually came from.
