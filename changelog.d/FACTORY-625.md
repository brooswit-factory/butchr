bump: minor

### Added

- A `PreToolUse` hook on Bash, written by butchr into each Claude workspace's
  own `.claude/settings.json`, that inspects the file a runner would execute
  and refuses a destructive payload hiding behind a benign-looking command
  line. This is the fix for the 2026-10-02 home-directory wipe, where
  `bun <file>` was approved on its command line while `x; rm -rf ~` sat inside
  the file. A hook receives the exact command text and cwd rather than a
  rendered screen, and runs in every permission mode including bypass.
  Blocks are written to the existing permission audit log; the mode
  (audit-only vs enforce) is read from a flag file at run time, so it can be
  changed without relaunching agents. Audit-only is the default. It is a cheap
  tripwire, not a sandbox — it cannot see through obfuscation, run-time-fetched
  payloads, or content changed between the check and execution.

### Changed

- Claude's pre-launch workspace files (`mcp.json` plus the new hook) are now
  written by one shared step used by BOTH the spawn and resume paths, instead
  of `mcp.json` alone on resume. A resumed session previously ran its entire
  first turn without anything `buildWorkspace` writes, because that runs only
  after the relaunch is verified.
- `hooks/` joins `src/`, `schema/`, `briefs/` and `package.json` as a
  release-gated path, since its contents are embedded into the built binary.
