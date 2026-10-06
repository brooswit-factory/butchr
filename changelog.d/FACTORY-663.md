bump: minor

### Added

- `dashboard-app`: the Rules page's write path — a guided "Set up your first
  rule" flow for the seeded `ui-first-rule` template (FACTORY-669): starter
  query examples, Preview (via the existing dry-run endpoint), a plan-then-
  confirm step naming spawned/stopped/restarted and scope ("stage N
  tickets") before anything is enabled or changed, Enable/Disable, and
  Undo via the write's own returned backup id. When the template rule is
  missing, the page shows the JSON snippet and file path to add it instead
  of writing anything. When `GET /api/rules` reports `stale: true`, every
  write control on the page is disabled ("reload pending") and `ifMatch`
  always carries `sourceEtag`, never `fileEtag`. Writes only ever reach
  `ui-`-prefixed rule ids — this slice adds no generic "create a rule"
  capability.
- `dashboard-app/src/api/rules.ts`: extended with the write contract named
  on PR #647 (FACTORY-662) — `GET /api/session` (CSRF), `POST
  /api/rules/plan` (report-only, now with an optional `scopeCount`), `POST
  /api/rules/:id/enabled`, `PUT /api/rules/:id`, and `POST
  /api/undo/:backupId` — plus `sourceEtag`/`fileEtag`/`stale` on the
  existing `GET /api/rules` read. `realRulesApi`'s `capabilities.write`
  starts `false` and is flipped only by a caller-driven
  `refreshCapabilities()` call that succeeds against a real `GET
  /api/session`, so the page keeps working (reads only) against today's
  main even before PR #647 merges. `createFixturesRulesApi` gained matching
  in-memory write/undo/plan behavior, replaying the real server's own
  refusal wording (stale etag, non-`ui-` id, placeholder query, over the
  25-ticket scope ceiling, a stop/restart without confirm, undo scoping)
  plus a one-shot `nextWriteError` for simulating a write-time-only failure
  (e.g. a stale lock).
