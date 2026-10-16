bump: minor

### Added

- **Event/wake path for standalone Confluence pages (FACTORY-997, epic FACTORY-348).** A new `ResourceType<ConfluencePageSnapshot>` (`src/resources/confluence-page.ts`) can tell a Confluence page's version bump (an edit) apart from a new footer comment arriving, purely from two polls' snapshots — no owning Jira ticket required. Proven end to end through the real, unmodified `runResourceLoop` with a fake Atlassian ops layer. `NotifyReason` gained two new members, `confluencePageEdit` and `confluencePageComment`. This story's `discovery`/`activation`/`spawnConfig` are deliberately minimal placeholders; the sibling story FACTORY-992 owns the real `confluence-page` provider (discovery, activation, spawn) this event half will plug into.
