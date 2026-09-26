---
bump: patch
---
FACTORY-93: lizard mode presses option 1 "Yes" (allow once) instead of the "always allow" option, so Claude's read-permission dialog ("Yes, allow reading … from this project") no longer freezes a lizard-mode agent; skipped panes are now logged once per pane+reason. Requires `@brooswit/drovr` 0.15.1.
