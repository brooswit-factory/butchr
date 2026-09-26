bump: minor

### Added
- A Bug caller now gets the same boss-tier `new_worker` grant an Epic caller
  has: it creates a Story (staffed by `roles.story`, linked back via
  Implements), never a worker of its own. `adopt_worker`, `correct_worker`,
  `prioritize_worker`, `start_worker`, `shelve_worker`, `tell_worker`,
  `ask_boss`, `report_to_boss`, `submit_to_boss`/`finish_worker`, and the
  self-close guard (refusing a self-transition to Done/In Review while a
  Story is still open) already generalized to any caller type via the
  existing link-based ownership checks — this ships the one gap that was
  actually type-keyed. A top-level Bug (no Epic) reaches Done through the
  same `finish_without_a_boss` path an Epic uses, with no code change
  needed, since that path is also link-based, not type-keyed.
- The BUTCHR-110 tier-identity collision check now describes a Bug caller
  honestly (no role variable governs a Bug's assignee) instead of
  mislabeling it as governed by `BUTCHR_ASSIGNEE_EPIC`.

This is a rule-file change only (`src/tools/relationship.ts`), not applied to
any host's live daemon config — it awaits the normal assembly rollout.
