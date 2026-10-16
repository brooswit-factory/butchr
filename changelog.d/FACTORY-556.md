bump: patch

### Added

- CI: a `windows` job on `windows-latest` installs Bun and runs the same
  typecheck + unit/load test commands the Linux job runs, `continue-on-error:
  true` so it does not block `main` while Windows support is built out.
