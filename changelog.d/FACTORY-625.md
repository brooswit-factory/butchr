bump: minor

### Added

- Lizard-mode permission auto-approval now pre-scans each eligible pane's
  pending Claude tool-permission dialog before pressing anything, and vetoes
  a file-executing command (`bun test`/`bun run`/`node`/`python`/`sh`/`bash`/
  `zsh <file>`/`source`/`./file`, a here-doc body, or a `curl|wget | sh`
  pipe) whose content matches a narrow destructive-pattern list (`rm -rf`
  against `~`/`$HOME`/`/`, `dd`/`mkfs`, a redirect onto a sensitive path,
  `chmod -R`/`chown -R` on `~` or `/`, a fork bomb). A vetoed pane is left
  blocked for a human rather than approved, logged once per pane+reason, and
  audited; an unreadable, oversized, or outside-workspace file target fails
  the same way, never silently approved. This is a cheap tripwire, not a
  sandbox — see the PR description for its limitations.
