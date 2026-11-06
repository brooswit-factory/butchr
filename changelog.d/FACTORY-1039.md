bump: minor

### Added
- An Epic or Task agent with `linkedEventing` enabled now also discovers its native Jira children — a Story/Task attached to an Epic purely via Jira's `parent` field, or a Task's own native subtask — and receives the same coalesced linked-change notification for a child's status/summary/comment change or removal that an explicit `issuelink`/`parent` target already gets. A child already reached through an explicit link is deduplicated to that link's kind, never double-reported. Subject to the same `maxLinkedItems` cap as every other linked-item kind, with a WARNING logged when the cap or a failed fetch leaves native-child coverage incomplete for a tick.
