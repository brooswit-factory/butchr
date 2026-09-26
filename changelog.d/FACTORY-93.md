---
bump: patch
---

### Fixed

- Lizard mode now presses option 1 "Yes" (allow once) instead of the "always allow" option, so Claude's read-permission dialog ("Yes, allow reading … from this project") no longer freezes a lizard-mode agent (FACTORY-93). Requires `@brooswit/drovr` 0.15.1.
- Skipped permission prompts are now logged ("SKIPPED, left for a human: <reason>"), once per pane and reason, instead of silently.
