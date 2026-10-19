bump: patch

### Changed

- **`briefs/_before-you-stop.md` (shared by every brief) now moves genuinely blocked
  work to To Do (FACTORY-1021, follow-on to FACTORY-1020).** When scoped work cannot
  proceed because of a confirmed unresolved dependency, a required approval, a
  quota/capacity limit, denied or missing access, or another actual hold, move the
  issue to To Do before stopping or going idle — this takes precedence over staying
  In Progress for queue/staffing eligibility. Every existing hold, label, assignee,
  and implementation/PR/reviewer continuity is preserved; the status change grants no
  permission and neither finishes nor cancels the work, and an existing PR is never
  closed or abandoned just because its issue moves to To Do. Post one concise comment
  when the blocked state actually changes (cause/evidence, exact unblock condition,
  next owner/action) and never repeat an unchanged blocker comment on every wake.
  Ordinary pending CI or an active requested review is not automatically a blocker,
  and draft/revision work that can still continue stays In Progress. Moving a blocked
  issue back to In Progress requires confirming the blocker is actually resolved and
  implementation has actually resumed — never inferred from elapsed time, a label
  change, or merely waking up. The existing generic transition-discovery, To-Do-only
  authorized-route, and readback/failure-reporting rules (and the project-key
  exemption) already cover this new target status unchanged.
- `test/unit/before-you-stop-coverage.test.ts` gains one falsifier per named DoD
  scenario for the blocked-to-To-Do rule, plus coverage that it resolves into every
  known brief tier and both kickoff prompts.
