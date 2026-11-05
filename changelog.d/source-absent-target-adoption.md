bump: patch

### Fixed
- Add a supported audited `fresh-target` operator workflow for a retired historical partial handoff whose original source pane is gone. It verifies the existing target's original permit/native/process/workspace binding and actual desired launch preferences, preserves source and target histories and dirty work, and reconciles only the obsolete history-transfer hold. It never launches, closes or prompts a worker. Service quiescence, the daemon writer lease, independent holds and exact reviewed-plan confirmation remain required; interrupted or mismatched ownership fails closed.
