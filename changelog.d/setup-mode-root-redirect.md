bump: patch

### Fixed
- **Setup mode no longer dead-ends on the legacy dashboard.** `GET /` and `GET /configurations` now 302 to `/dashboard-app/` while the daemon is in setup mode, so a fresh install that lands on the root URL is sent straight to the React setup wizard instead of a server-rendered dashboard showing a yellow "COULD NOT CHECK — this daemon's agent-list read failed, or has never succeeded yet" error with no visible navigation to the wizard. The legacy pages are unchanged once Atlassian identity is configured.
