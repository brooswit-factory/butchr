bump: minor

### Added

- `dashboard-app`: a Rules page (next to Dashboard and Configurations) —
  lists every configured rule (id, enabled badge, provider, query,
  `execution`, why-unstaffed), a per-rule Preview (matching ticket keys and
  total, linked), and an enable/disable toggle. The toggle calls a plan
  endpoint first and requires confirmation before applying any change that
  would stop or restart running agents. Built against a new, single typed
  client module (`dashboard-app/src/api/rules.ts`) with a fixtures
  implementation (dev/test) and a real one targeting the FACTORY R1 slice's
  `GET /api/rules` / `GET /api/rules/:id/preview` and FACTORY-662's `POST
  /api/rules/plan`; the actual write endpoint doesn't exist yet, so the
  toggle renders disabled with a "needs the write API" explanation until
  the write-path slice lands.
