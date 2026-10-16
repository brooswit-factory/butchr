bump: patch

### Fixed
- Dependencies: butchr now consumes drovr 0.16.11 (was 0.16.10), which fixes `classifyPermissionPrompt` rejecting a permission dialog whose last option is overdrawn as `Nor you` at a 40-column pane width. The accept gate now anchors on the LAST option matching `/^No/` instead of requiring some option to match `/^No\b/`, so workers no longer sit blocked on a dialog the daemon could not see (FACTORY-774, FACTORY-812). A running daemon keeps serving the build it started with, so this takes effect only once the daemon is rebuilt or restarted.
