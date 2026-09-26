bump: patch

### Changed
- **`briefs/bug.md` rewritten from a ~21-line worker-tier stub into the
  boss-tier `@builtin:bug` brief** (FACTORY-38/FACTORY-40, epic FACTORY-36):
  a Bug's agent now triages and reproduces the reported symptom, records
  the diagnosis on its own doc BEFORE filing anything, decomposes the fix
  into one or more Stories via `new_worker`/`adopt_worker` (never fixing
  code itself), formally reviews each Story's PR with the same
  `[review] APPROVED|CHANGES_REQUESTED <pr-url> @ <full 40-char sha>`
  protocol `epic.md`/`story.md` use, then — once every Story is Done —
  re-verifies the original symptom is actually gone end-to-end and records
  the fixing commits and rollback instructions as its doc's closing
  summary. Closing branches on whether the Bug has a parent Epic
  (`report_to_boss`/`submit_to_boss`, waits for `finish_worker`) or is
  top-level (`finish_without_a_boss`, the existing verb — FACTORY-37/39's
  own mechanism work was still unmerged at this branch point, so no new
  closing verb was introduced here). States the Done-gate in words: a Bug
  never closes itself while any of its Stories is not Done.
- `test/unit/merge-check-guard.test.ts` / `test/unit/assertion-check-guard.test.ts`:
  `bug` moved from each file's `TYPE_EXCLUSIONS` into the real
  positive-assertion lists (`REVIEW_LINE_INSTRUCTING_BRIEFS` /
  `ASSERTION_CHECK_INSTRUCTING_BRIEFS`) now that `bug.md` actually reviews
  a Story's PR and reads its test diff the same way `epic.md` does. The
  `merge-check-guard.test.ts` DEFAULT-fallback probe that used to
  piggyback on the literal type name `"Bug"` (back when `bug` wasn't yet a
  tracked `knownBriefTypes()` member) now uses `"Sub-task"` instead, so it
  keeps exercising the untracked-type/DEFAULT path instead of silently
  duplicating the now-real `brief:Bug:*` channels.
- `test/unit/workspace.test.ts`: new dedicated coverage asserting the
  resolved `@builtin:bug` brief is boss-tier (teaches `new_worker`, sends a
  `[review]` line, states the Done-gate) and carries none of the old
  worker-stub's phrasing (no "identify the smallest correct fix", no
  "work in the repository and branch named by the ticket", no "submit the
  bug for review", and no author-side merge check — a Bug never authors
  its own PR).

No test assertions were weakened or removed: `git diff
origin/FACTORY-38...HEAD -- test/ | grep '^-.*expect(' || true` has zero
output — every changed line in `test/` moved a brief-type literal between
an exclusion array and its matching positive-assertion array, or added new
`expect()` coverage; no existing `expect()` call was deleted.
