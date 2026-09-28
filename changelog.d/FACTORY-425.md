bump: minor

### Added
- Host-side counting of Codex unrecognised-dialog sightings per fingerprint
  (`src/agents/codex-dialog-sightings.ts`), a new independent poll loop
  driven only by drovr's read-only `scanPendingCodexApprovals`. Counts are
  per-(pane, fingerprint) EPISODE, not per poll, and surface via a new
  `/health` sibling field, `codexUnrecognisedDialogSightings`, plus a
  `[codex-unrecognised]` journal marker (FACTORY-425, implements FACTORY-419).
