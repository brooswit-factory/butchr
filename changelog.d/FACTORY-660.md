bump: minor

### Added
- `GET /api/rules`: the validated rules file state (path, mtime, validation problems) plus per-rule fields (id, resourceProvider, query, enabled, execution, account, role, agentPreferences, linkedEventing, mcpServerNames, a 200-char brief excerpt, and staffed/whyUnstaffed) for the rules page, guarded by the dashboard's own Origin/Host check.
- `GET /api/rules/:id/preview`: a read-only, rate-limited, capped dry-run of one rule's query against Jira (ticket keys and a total count only, never Jira's own error body), guarded by the same Origin/Host check plus a same-UID loopback peer check.
- `src/web/dashboard-origin-guard.ts` and `src/web/peer-uid.ts`: shared guard helpers for the two routes above, reused by FACTORY-662's write-path routes.
