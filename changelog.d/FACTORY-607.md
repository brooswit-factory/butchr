bump: minor

### Added

- Managed-session Rocket.Chat escalations now neutralise every quoted field (the pane's question, options, fingerprint and capture path) before posting: confined to one uncloseable fenced code block, every `@` and `://` defanged with a zero-width space, control characters and `\r` stripped, and a stated character/option cap with an explicit truncation marker — a prompt containing `@all`/`@here`/a markdown link can no longer ping real people or break formatting when posted from the new butchr-escalation bot account.
- Managed-session escalations now re-escalate in tiers: an immediate first post, a second at `BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES` (default 10 minutes) if the same episode is still blocked, and a third to the director in `#team-engineering` at `BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES` (default 20 minutes). Rooms, mentions and delays all come from config (`BUTCHR_MANAGED_ESCALATION_ANSWERER_MENTION`, `BUTCHR_TEAM_ADMIN_ROOM`, `BUTCHR_MANAGED_ESCALATION_ASSEMBLY_MENTION`/`_ROOM`, `BUTCHR_MANAGED_ESCALATION_DIRECTOR_MENTION`/`_ROOM`), defaulting to the director's own routing. Tiers 2/3 are exempt from the existing per-pane hourly rate cap, so one long episode's own tiers can never exhaust a pane's budget and silently swallow a later episode's tiers within the same hour.

### Changed

- **Admin-assembly's own pane now routes to `@manager-factory` in `#team-engineering` for tiers 1-2** (tier 3 still goes to the director, same as every other managed session) — previously it routed to `@director` in `#team-admin`. Override `BUTCHR_MANAGED_ESCALATION_ASSEMBLY_MENTION`/`BUTCHR_MANAGED_ESCALATION_ASSEMBLY_ROOM` to restore the old values if needed.
- The injected `teamAdminNotify` dependency now takes the room per call (`(room, text) => Promise<void>`) instead of being bound to a single hard-coded room — there is one Rocket.Chat credential shared across every room this feature posts to, never one per room.
