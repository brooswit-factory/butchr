bump: minor

### Added

- **Atlassian is now an optional, independently-enable/disable-able provider, matching the precedent `github?`/`rocketchat?` (`src/config/config.ts`) and the `githubIssueStaffing`/`zendeskTicketStaffing` staffing pattern already established for other providers (FACTORY-66).** `Config.atlassian` is `{ site, email, token } | undefined`; it stays fully populated on any existing host with a complete `ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN`(`_FILE`) — byte-for-byte unchanged behavior there. A new `BUTCHR_ATLASSIAN_ENABLED=false` (also `0`/`no`/`off`) explicitly disables Atlassian on an already-configured host, bypassing setup mode entirely; `jira-work`, `jira-idea`, `jira-project` and `confluence-page` (the four Atlassian-backed `RESOURCE_PROVIDERS`) are then not staffed — no client constructed, no credential read, no polling — and reported `enabled: false` with a named reason in `/health` and the daemon's startup log, while every other provider (`github-issue`, `github-pr`, `zendesk-ticket`, `filesystem`) is unaffected.
- `atlassianProviderStaffing` (`src/rules/atlassian-staffing.ts`), a shared `{run, rules, reason}` staffing decision (same shape as `githubIssueStaffing`) covering all four Atlassian-backed providers from one credential.

### Fixed

- **The partial-Atlassian-credential boot-refusal (`process.exit(1)`) in `src/daemon/index.ts`, left over from PR463/FACTORY-65, is removed.** A partial or invalid Atlassian credential (one field missing, a malformed `ATLASSIAN_SITE`, an unreadable `ATLASSIAN_TOKEN_FILE`, an empty token) is now an isolated, provider-specific condition — `Config.atlassianDisabledReason` names exactly what's wrong, the four Atlassian-backed providers report it in `/health`, and the daemon still starts and runs every other configured provider normally. It is never a process-wide startup failure.
- **An unreadable `GITHUB_TOKEN_FILE` no longer crashes `loadConfig`/the daemon.** `github` (documented as optional) now stays `undefined` on a read failure, same as if it were simply unset; `Config.githubTokenReadError` names the read failure for the startup log.

### Changed

- `src/daemon/index.ts`'s jira-work/jira-idea/jira-project/confluence-page loops, Atlassian/Confluence MCP tool registration, and the handful of cross-cutting Atlassian reads (dashboard resource links, the settings-page Jira connection test, token rotation) all now check `config.atlassian`/the relevant staffing result before touching Atlassian, instead of assuming it is always present.
