bump: major

### BREAKING
- **Managed sessions are removed:** the session-definitions loop, its tools, its dashboard pages and `/api/session-definitions/*`. `BUTCHR_SESSION_DEFINITIONS_DIR` and `BUTCHR_SESSION_ARCHIVE_DIR` are no longer read, and neither are the definition files.
- **Rocket.Chat is removed:** the client, routing escalations to rooms, and posting ops alerts. Ops alerts are journal lines only. `ROCKETCHAT_*`, `BUTCHR_TEAM_ADMIN_*`, `BUTCHR_MANAGED_ESCALATION_*`, `BUTCHR_OPS_ALERT_ROOM` and `BUTCHR_OPS_ALERT_MENTION` are no longer read, and a rule's `account` field is accepted and ignored.
- **Managed links are removed:** the link stores and `BUTCHR_LINKS_STORE_FILE`, the agents' `list_links`/`add_link`/`remove_link` tools, `butchr link`, `/api/links*` and the Links page. Linked-change events still watch Jira issue links, remote links, description links and the ticket's own pull request.
- **Idle pokes and lizard mode are opt-in per rule.** A rule that doesn't set `idlePokeEnabled` or `lizardMode` now has both off. Before, both were on, while the dashboard showed an unset `lizardMode` as off.

### Added
- **The dashboard is rebuilt on LaunchPad.** Rules edits every rule inline as one draft, and Review and save dry-runs each change before writing it. Agents lists the running agents with stop, priority, boss and start. Status shows health, the loops and the daemon log, with reload and restart. Settings groups the daemon settings, has a Providers section that writes tokens behind the setup code, and a Rule types card for the per-provider switches. Coming soon lists what butchr does that the dashboard can't show or change yet.
- **`trello-card` rules:** agents for cards on one Trello board, with `trello_get_card` and `trello_add_comment` tools. Off until `BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK` is set, like zendesk-ticket (see `docs/trello-card.md`).
- **Linked-change events watch a ticket's own pull request** (a branch named `KEY` or `KEY-…`) and wake its agent on new comments, review comments and reviews.
- **Settings can save the GitHub token and organizations, the Zendesk subdomain and token, and the Trello board, key and token.** They apply after a restart. `~` is expanded in token file paths.

### Changed
- `/` is the Status page, and `/daemon` redirects there. Configurations is folded into Rules: `/configurations` redirects to `/rules`, keeping a rule's anchor.
