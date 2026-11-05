bump: patch

### Fixed
- Reaper and defensive cleanup now preserve partial/pending handoff source and target workspaces, including agentless sources. Cleanup rechecks policy and exact pane/workspace ownership before closing; missing policy proof, changed ownership, holds or stale authority refuse cleanup. Empty censuses retain transaction evidence across restarts, and cleanup diagnostics expose the active protection.
