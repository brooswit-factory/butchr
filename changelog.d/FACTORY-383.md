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
