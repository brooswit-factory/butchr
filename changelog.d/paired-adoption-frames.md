bump: patch

### Fixed
- Source-absent adoption now pairs complete visible ANSI and plain detection frames with matching pane, workspace, tab and revision. Stable terminal/native identity and foreground process generation bracket the reads. This handles Herder's plain detection response without weakening the draft guard or sending terminal input. Changed frames and unrelated readiness holds still refuse adoption.

- Keep pane identity revisions separate from rendered-frame revisions: each must remain internally consistent, while the two APIs use different counters.
