bump: patch

### Fixed
- **`formatUnparseableLine`'s no-dialog branch now sanitizes its quoted pane
  text** (FACTORY-834, follow-up from FACTORY-811/815's PR #702 review).
  The branch that logs the ordinary `blocked with no parseable dialog`
  line only `trim()`+`slice()`d the quoted text, unlike the sibling
  `[unrecognized-dialog]` marker branch which already wraps its window in
  `sanitizeForJournal`. An interior newline in pane text could survive
  into the journal and forge a fake `[unrecognized-dialog]` line,
  defeating the guarantee that grepping that marker finds exactly the
  defect case. Both branches now go through `sanitizeForJournal`.
