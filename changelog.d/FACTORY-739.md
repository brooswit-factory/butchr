bump: minor

### Added
- Shared `briefs/_before-you-stop.md` section, included by every brief template (epic, story, task, bug, project, default) via a minimal build-time include, requiring a worker to comment on its own ticket — what it did, links, what's left, blockers, next owner — before stopping or going idle.
- The same reminder now also appears in the Claude/non-Claude kickoff prompt (`KICKOFF_PROMPT`/`AGENTS_KICKOFF_PROMPT`), so it is in context from an agent's first turn, not only inside `brief.md`.
