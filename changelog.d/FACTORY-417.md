bump: minor

### Added

- **A managed-session definition's `brief`/`workingDirectory` edit now
  pushes the new content directly to the running agent (FACTORY-417,
  implements story FACTORY-412, epic FACTORY-394)**, instead of the same
  generic "this changed, re-read it" nudge every other definition-field
  edit still gets. `createSessionDefinitionEventRules`'s `decide()`
  (`src/rules/session-definition-type.ts`) now content-diffs `brief` and
  `workingDirectory` specifically against the previous parsed definition and
  attaches a new `NotifyReason` member, `definitionField`, carrying whichever
  field(s) actually moved and their new value(s); every other field (vendor,
  tier, permissionMode, ...) still delivers with no `reason` at all,
  byte-for-byte unchanged. `sessionDefinitionFieldNudge`
  (`src/agents/change-nudge.ts`) renders it as a direct instruction — the new
  brief text verbatim, and "operate in `<new dir>` from now on" for
  `workingDirectory`, explicit that this is not a process cwd move. The new
  text is pushed directly rather than telling the agent to re-read
  `brief.md`, because `buildWorkspace()` (the only code path that rewrites
  `brief.md` on disk) runs only from the spawn/resume path, never on an
  ordinary poll against an already-running agent — a re-read instruction
  would point at stale content with no race to even win. Reuses the existing
  size/mtime diff-and-deliver machinery unchanged, so idempotence (an agent
  is notified once per actual change, never re-nudged on a poll where
  nothing moved) is inherited, not reimplemented, and `resumeInPlace()`/
  `staleIssues()`/the respawn path are untouched — this is a change-nudge
  addition only.
- **Proven live**, not just by unit test: a real throwaway managed-session
  pane's `brief`/`workingDirectory` were edited mid-session against a
  standalone daemon instance pointed at a scratch `session-definitions`
  directory; the SAME running process (pid, transcript session id both
  unchanged across the edit and several subsequent polls) received the
  content-push nudge and acted on the new brief immediately, with no
  respawn and no repeat nudge on later polls.
