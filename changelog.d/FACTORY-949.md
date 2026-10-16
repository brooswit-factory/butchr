bump: minor

### Added
- An `agent:*` label transition to `agent:blocked` now wakes the blocked ticket's boss (the other end of its own outward Implements link) and the project's manager, each debounced per ticket (`BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES`, default 10 minutes) and deduped against escalate.ts's own `[butchr:blocked]` marker for the same episode. Never wakes the blocked ticket's own watcher or a sibling's watcher; a ticket with no boss still wakes the project's manager. Every other `agent:*`/`pr:*` transition stays exactly as silent as before.
