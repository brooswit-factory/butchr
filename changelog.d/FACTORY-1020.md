bump: patch

### Changed

- **`briefs/_before-you-stop.md` (shared by every brief) now makes workers own their
  own verified In Review/Done transitions (FACTORY-1020, follow-on to FACTORY-735/739).**
  Before any `jira_transition`, freshly re-read the issue's status, comments, holds
  and PR state, and discover the live transition schema instead of hardcoding an ID.
  Move to In Progress only when implementation actually starts; move to In Review only
  once review-ready work, with a current-head PR/artifact and its evidence, is linked —
  a draft PR or a `CHANGES_REQUESTED` review sends it back to In Progress, and an
  existing review thread is reused rather than duplicated. Move to Done only with every
  scoped requirement's linked evidence (review, merge, release/deployment, end-to-end
  acceptance where required) or an explicit user waiver — never inferred, and never
  because the agent is merely stopping or blocked. Every transition is read back and
  verified; a failed, unavailable, denied, or mismatched transition is reported rather
  than silently claimed or substituted, and a newer conflicting owner action or hold
  always wins. The section now explicitly exempts project resources (which own no Jira
  issue of their own) from these issue-transition instructions, so the resolved
  `project.md` brief never directs a `jira_transition` call against its own project key.
- **New shared fragment `briefs/_recursive-child-closure.md`**, included in the
  parent-tier briefs that can own descendants (`epic.md`, `story.md`, `bug.md`,
  `project.md`): before closing, recursively verify every descendant's real status and
  its own closure/acceptance evidence at every level — not just the immediate child — so
  a Done direct child can't conceal unmet or unevidenced grandchild work. `task.md`/
  `default.md` do not get this include; a bare Task owns no children.
- `src/agents/workspace.ts`'s `resolveIncludes` now resolves a second include marker
  (`RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER`) the same way it already resolved
  `BEFORE_YOU_STOP_INCLUDE_MARKER`, so both kickoff prompts (`argv.ts`'s
  `KICKOFF_PROMPT`/`AGENTS_KICKOFF_PROMPT`) and every `briefFor()` tier pick up the new
  text from one source.
