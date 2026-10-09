bump: patch

### Fixed
- **Every agent spawn failed with `invalid_agent_argument` ("agent arguments cannot be encoded safely for the target shell").** FACTORY-735/739 made the Claude/Codex/Agy kickoff prompt multi-line, which herdr's `agent.start` rejects before ever shell-quoting it. The kickoff is one line again, and a new butchr-side pre-flight guard now rejects any control character in a start argument with butchr's own clear error, before `agent.start` is ever called — covering a rule's own multi-line `brief` too, not just the two kickoff constants.

### Added
- A CI job starts a real agent through a real herdr with the real kickoff argv and asserts it starts, so this class of break fails in CI instead of reaching production.
