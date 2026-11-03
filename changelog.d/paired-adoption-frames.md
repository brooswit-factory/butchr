bump: patch

### Fixed
- Source-absent adoption now pairs complete visible ANSI and plain detection frames with matching pane, workspace, tab and revision. Stable terminal/native identity and foreground process generation bracket the reads. This handles Herder's plain detection response without weakening the draft guard or sending terminal input. Changed frames and unrelated readiness holds still refuse adoption.

- Keep pane identity revisions separate from rendered-frame revisions: each must remain internally consistent, while the two APIs use different counters.

- Read existing owner-owned group-writable source history only when its complete stable-file hash matches the original trusted immutable snapshot; target histories and world-writable files remain refused. No native files or permissions are changed.
