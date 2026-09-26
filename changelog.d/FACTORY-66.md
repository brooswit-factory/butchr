bump: minor

### Added

- Atlassian credentials (`ATLASSIAN_SITE`/`ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN`
  or `ATLASSIAN_TOKEN_FILE`) are now optional, same all-or-nothing shape as
  `GITHUB_TOKEN_FILE`/`BUTCHR_GITHUB_ORGS`. Leaving all three unset disables
  Jira/Confluence entirely (a clear startup log line says so) so a
  managed-sessions-only host, or one staffed entirely by
  github-issue/zendesk-ticket/filesystem rules, no longer needs throwaway
  Jira credentials to boot. Setting only one or two of the three is still a
  startup error, naming exactly what's missing. The daemon refuses to start
  if a loaded `jira-work`/`jira-idea`/`jira-project` rule is enabled with no
  Atlassian configured, since that rule could never be staffed. With
  Atlassian disabled, the jira_*/confluence_* MCP tools and `butchr link` on
  a jira-project resource stay registered and refuse with a clear
  "Atlassian is not configured on this host" error if called, rather than
  crashing or vanishing. `describeConfig` now prints `atlassian=disabled`
  in this case, mirroring `github=disabled`.
