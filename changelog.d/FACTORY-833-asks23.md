bump: minor

### Added
- The coalesced linked-change notice (`linkedChangeNudge`) now names the specific provider link id (`issuelink 12027`, not just `issuelink`) when the provider supplies one (Jira issuelink/remote-link ids), so a ticket sitting in more than one chain no longer leaves a reader guessing which link changed or was removed. Never fabricated — a kind with no comparable provider id (a project member, a managed link, any external kind) still renders exactly as before.
- Removing ONE of several distinct native issuelinks to the same target now reports that specific link's removal, even while the target stays linked via a sibling link — previously only a removal of the whole target's single collapsed watch entry could ever be detected, and removing several distinct links at once reported only one of them.
- Every status/comment/summary change line now names the linked issue's own last-observed-change timestamp ("as of ..."), so a transition detected late (a rate-capped tick, a slow poll cycle) is never presented as though it just happened — and a LATER, unrelated edit to a different field can no longer overwrite an already-held transition's own timestamp.

### Fixed
- Corrected a stale comment describing pre-review-round-1 watch-set-advance behavior that no longer matched what FACTORY-833's merged fix actually does.
- The actual remote-link eventing path (`jiraKindLinkedItems`) was discarding the provider's own remote-link id even after the parser-level plumbing for it landed; it is now carried through end to end.
