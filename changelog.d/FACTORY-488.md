bump: patch

### Fixed
- linked-change eventing no longer reports a false "no longer linked" for a butchr-managed link that becomes a native `Implements` link (e.g. a child adopted under an epic/story, or transitioning to Done). `nativeJiraRefs` now excludes an `Implements`/outward link the same way `jiraKindLinkedItems` already does, so the target stays "managed"-origin and keeps being watched instead of silently dropping out of the owner's tracked set.
