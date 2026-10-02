bump: patch

### Changed
- `briefs/task.md` now tells a Task's worker that a PR which really changes a repo with no
  `changelog.d/` yet also wires in the release gate (the `release-gate` consumer stub, pinned
  `@v1`) when the repo can carry a version (FACTORY-639).
