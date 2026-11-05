# What FACTORY-1036 actually guarantees about CLAUDE.md reaching an agent

FACTORY-1036 moved the shared "before you stop or go idle" section out of
the once-per-launch kickoff argv (`src/agents/argv.ts`'s `KICKOFF_PROMPT`/
`AGENTS_KICKOFF_PROMPT`) and into generated CLAUDE.md/AGENTS.md instead
(`briefs/CLAUDE.md`/`briefs/AGENTS.md`, written by
`src/agents/workspace.ts`'s `writePreLaunchClaudeFiles`). This document
states exactly what is MEASURED/TESTED about that move, and what is instead
relied on from Claude Code's own documented behavior, per the ticket's own
requirement: "Validate first-turn/after-compaction/stop guidance as
supported by the runtime. Document any limitation; do not claim
instructions are enforced merely because a file exists."

## What is tested, in this repo

- `writePreLaunchClaudeFiles` writes current CLAUDE.md/brief.md/
  ENVIRONMENT.md content before every launch this daemon performs: a fresh
  spawn, a crash/respawn (both via `buildWorkspace`), and an in-place
  `--resume` relaunch (`HerdrHerd.resumeInPlaceExclusive`, `src/agents/herd.ts`,
  calling it directly, BEFORE the relaunch attempt — see
  `test/unit/herd.test.ts`'s own "resumeInPlace() rewrites CLAUDE.md,
  brief.md, and ENVIRONMENT.md BEFORE reporting resumed" test).
- The resolved CLAUDE.md/AGENTS.md templates contain the same required
  before-you-stop text the kickoff prompt used to carry
  (`test/unit/before-you-stop-coverage.test.ts`).
- The kickoff prompt itself stays short and fixed regardless of brief size
  (`test/unit/argv.test.ts`), closing the specific regression (a 5,970-byte
  kickoff truncated at 4095 bytes by a canonical-PTY input path) that
  motivated this ticket.

All of the above is a claim about FILES ON DISK at the moment of a
(re)launch — it says nothing, on its own, about what Claude Code actually
does with those files afterward. That is the next section.

## What is relied on from the runtime, NOT independently verified here

Claude Code's own documentation
(<https://code.claude.com/docs/en/memory>) describes `CLAUDE.md` as loaded
into the agent's memory/system context at the start of a session — this is
the basis for believing it survives a long session's own context
compaction (which operates on the conversation transcript, not the system
prompt) in a way a one-time kickoff-argv copy of the same text cannot. No
measurement in this repository (unit test, smoke test, or otherwise)
independently confirms this for the exact Claude Code build this fleet
runs — doing so would require actually running a real Claude Code session
long enough to trigger compaction and then checking whether its own
guidance still reflects CLAUDE.md, which is outside what an automated test
in this repo can drive. This is a documented product property being relied
on, not a measured one.

## The actual limitation

This fix guarantees freshness at (re)launch BOUNDARIES — fresh spawn,
respawn, and resume — never a live, mid-session hot-reload. An agent that
is already running and never relaunches will NOT pick up a changed
CLAUDE.md (an edited `briefs/CLAUDE.md` template, or a changed ticket
summary/parent affecting interpolation) until its next (re)launch. If a
future need arises for an already-running agent to see updated guidance
without restarting, this fix does not provide that — it would need its own
mechanism (e.g. a tool call that re-reads a file, or an explicit nudge),
not an assumption extended from this ticket.
