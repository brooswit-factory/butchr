---
bump: minor
---

### Added

- Resource-agent workspace directories now use the same short display id FACTORY-90 gave the herdr workspace label (e.g. `<root>/.../%2Fhome%2F...%2Fsession-definitions%2Fadmin-assembly.json` becomes `.../admin-assembly`) — `jira-work`/`jira-idea`/`jira-project` are unaffected (identity short ids). Lossless key resolution survives the change via a bookkeeping stamp written inside each claimed directory, validated against hostile/unsafe short ids, with sticky (never recompute-and-rename) and slug-collision-aware naming. A one-time migration moves an existing workspace's directory and, critically, Claude Code's own `~/.claude/projects/<slug-of-cwd>` memory/transcript directory alongside it — idempotent, reversible, and refuses rather than silently corrupting when it cannot safely determine the target (a non-empty destination, or a new path whose Claude Code slug would exceed the real 200-character truncation threshold). Never renames a directory a live agent still has as its cwd. `bun run scripts/migrate-workspace-layout.ts` (dry run by default, `--execute` to apply) is the new operator entry point; see `docs/workspace-layout.md` for the full design writeup, the empirical Claude Code slug-algorithm verification, and the deploy runbook.
