bump: minor

### Added

- **A distinct, greppable journal signal (`[unrecognized-dialog]`) for a
  blocked pane whose screen contains a real `Do you want to ...?` dialog
  that the parser rejected** (FACTORY-811/815, follows from FACTORY-774's
  measurement). The previous `blocked with no parseable dialog` line quoted
  only the first 60 characters of the TOP of the screen — never where a
  dialog sits — so it could not tell a real rejected dialog (a defect; a
  worker is stuck) from a pane that is simply busy with no dialog at all
  (normal); measured, 40/40 such lines in a 6h journal window showed
  ordinary scrollback, none a dialog. `onNoPrompt`
  (`src/agents/escalation-loop.ts`) now scans for a `Do you want to ...?`
  line and, when present, logs a bounded (400-char), tail-oriented window
  starting at that line — the option list and footer, never the scrollback
  above it — under the new `[unrecognized-dialog]` marker instead of the
  ordinary line. A screen with no such line keeps the original short,
  un-markered line unchanged. The existing de-duplication on a hash of the
  screen text is preserved for both cases, and the captured window goes
  through the same newline-flattening (`sanitizeForJournal`) already used
  elsewhere to close the BUTCHR-343/346 journal-forgery vector this exact
  log site was named in.
