bump: patch

### Fixed
- Deliver entry into `agent:stalled` to the ticket's own agent and every routed related watcher without swallowing it as a daemon label echo or letting the first recipient consume the others' event. Linked eventing also recognizes stalled entry. Preserve delivery limits, repeated-poll deduplication, and silent label cleanup/removal.
