bump: patch

### Fixed
- Linked-change eventing no longer reports a false "no longer linked" for a remote-linked or managed-linked target when that owner's remote-links fetch or managed-link-store read fails transiently. Removal detection is skipped (only) for that owner on the tick the fetch failed, and the owner's watch set is left untouched rather than overwritten with the failure-shrunk membership — so a genuine removal that happened during the same failed tick is still caught, exactly once, on the next successful tick, instead of being lost or fabricated.
