bump: minor

### Added

- Edit an existing rule's fields, including its JQL `query`, from the Rules
  page — a per-row Edit button opens a dialog reusing the shared plan ->
  confirm -> apply write path (ifMatch/etag, planHash, undo), with harness/
  model/effort/permission-mode options from the existing rule-form catalog.
  A changed query can be dry-run for its matching ticket count before saving.
- `GET /api/rules/:id/preview` accepts an optional `?query=` override, dry-
  running a draft (not-yet-saved) query through the same preview capability.

### Changed

- Retire the reserved `ui-` id prefix guard on the rules write path: any
  existing rule (not only the seeded `ui-first-rule` template) can now be
  edited/enabled from the dashboard. The field allowlist (`assertOnlyChanged`),
  plan-then-confirm flow, ifMatch/etag check, atomic backed-up write, undo,
  and audit line are unchanged and remain the only gates on a write.
