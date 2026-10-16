bump: patch

### Fixed

- A pane blocked (or stuck on unparseable text) with neither an issue key nor
  a resolved managed-session identity now durably captures its full pane
  text to `BUTCHR_CAPTURE_DIR`, instead of leaving only a single daemon
  journal line. Deduplicated per pane per fingerprint/text, capped and
  evicted alongside the existing capture kinds under a disjoint
  `ticketless-<blocked|unparseable>-<paneId>-<timestamp>.txt` name, and fails
  open exactly like the existing capture paths. Local-disk-only — nothing on
  this path is ever written to Jira.
- The unparseable-text path now also consults the pane's managed-session
  identity before capturing, exactly like the blocked-prompt path already
  did — a managed session stuck on garbled text is no longer misfiled under
  the ticketless capture shape.
