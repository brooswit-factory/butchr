bump: minor

### Added
- The coalesced linked-change notice (`linkedChangeNudge`) now names the specific provider link id (`issuelink 12027`, not just `issuelink`) when the provider supplies one (Jira issuelink/remote-link ids), so a ticket sitting in more than one chain no longer leaves a reader guessing which link changed or was removed. Never fabricated — a kind with no comparable provider id (a project member, a managed link, any external kind) still renders exactly as before.
- Every status/comment/summary change line now names the linked issue's own `updated` timestamp ("as of ..."), so a transition detected late (a rate-capped tick, a slow poll cycle) is never presented as though it just happened.

### Fixed
- Corrected a stale comment describing pre-review-round-1 watch-set-advance behavior that no longer matched what FACTORY-833's merged fix actually does.
