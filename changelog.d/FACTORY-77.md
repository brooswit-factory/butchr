bump: patch

### Fixed
- `session-limit-watch.ts`'s `CAPTURE_NAME` now recognises `jira-project` rule-engine agents' own session-limit capture files, so they are counted toward the eviction cap and evicted like every other provider's captures instead of accumulating forever.
