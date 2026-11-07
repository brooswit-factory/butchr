bump: minor

### BREAKING
- **The one-time setup code is gone, everywhere.** `POST /api/setup/jira`, `PUT /api/settings/jira/token`, `PUT /api/settings/github/token`, `PUT /api/settings/zendesk/token` and `PUT /api/settings/trello/credentials` no longer accept or require a `setupCode` field in their request bodies. The 10-minute single-use base32 code that was printed to the daemon's own journal/stdout on startup and SIGUSR2 is no longer minted or logged, and the SIGUSR2 handler that minted a fresh one is no longer installed. The dashboard-app's Setup page and the four Settings → Providers token forms no longer render a "Setup code" input. `GET /api/settings`'s `CredentialsSummary` no longer carries a `setupCode: { command, findCommand, where }` block, and the Providers section no longer renders a "Getting a setup code" help card. External scripts posting to these routes should drop `setupCode` from their payloads; the field is now ignored but no longer required.

### Changed
- **Setup is one step on a fresh install.** Opening the dashboard, typing site/email/token and submitting is all it takes; the "fish the code out of your journal, type it in, hope it hasn't expired" step is gone. The write-guard chain already protects these routes (same-UID peer check on the TCP client via `isSameUidPeerAsync`, loopback-only listener, CSRF, origin/host) — that is the real security boundary, not the code, since any process already inside the daemon's UID can read the 0600 token files it writes and spawn arbitrary shell via herdr's own same-UID socket at `~/.config/herdr/herdr.sock`.

### Removed
- `src/setup/setup-code.ts` (`createSetupCodeManager`, `installSetupCodeSigusr2Handler`, `SetupCodeManager`, `SETUP_CODE_TTL_MS`, `SETUP_CODE_MAX_ATTEMPTS`), its unit test and its load test.
- `setupCodeInstructions()` from `src/web/credentials-api.ts`.
- The `ownPid` field from `CredentialsSummaryInput` (its only use was `setupCodeInstructions`).
