bump: patch

### Fixed

- `new_worker`'s duplicate-child idempotency check and `stand_down`'s watch
  set (BUTCHR-307) now also see a not-Done child linked ONLY by Jira's
  native `parent` field (no `Implements` link) — completing FACTORY-909's
  own fix, which closed this gap for the boss-side closing guard
  (`finish_worker`/`finish_without_a_boss`/`submit_to_boss`) but deliberately
  left these two call sites Implements-only. A boss with such a child no
  longer files a duplicate Story/Task for work that may already be running,
  and a parent-only child's status change, question, or `[butchr:blocked]`
  escalation can now wake a boss that stood down waiting for it.
