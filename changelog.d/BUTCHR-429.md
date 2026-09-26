bump: minor

### Added

- Pure link discovery over data a `jira-work` rule's poll already fetches:
  every `issuelinks` entry (all types, both directions) and the native
  `parent`, de-duplicated and logged as `[linked-discovery]` per resource,
  gated on change so an unchanged set logs only once
  (`src/resources/linked-discovery.ts`, `src/jira-watch/linked-discovery-log.ts`).
  Also exposes (unwired, pending future stories' own fetch) parsers for Jira
  remote links and description-text URLs (Confluence pages, GitHub issue/PR
  links via a new `githubPrRefFromUrl`, and a generic webpage catch-all).
- Four additive, opt-in per-rule config knobs — `linkedEventing`,
  `linkedPollIntervalMs`, `maxLinkedItems`, `maxLinkedTurnsPerHour` — typed
  and validated on `rules.json`, absent/inert by default; `maxLinkedItems`
  already caps discovery and logs skipped extras.
