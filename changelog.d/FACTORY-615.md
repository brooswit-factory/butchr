bump: minor

### Added
- `/dashboard-app/` now renders the real main dashboard — build/currency
  header, page banner, admission panel, one row per agent and one per
  withheld ticket, and the hint line — polling `GET /dashboard` (and a new
  `GET /health` poll for the build/currency header) every 5s with no
  full-page reload, built from real `@launchpad-ui/components`
  (`LinkButton`, `Alert`/`AlertText`, `Text`, `Link`) over the LaunchPad
  design tokens. The old server-rendered `GET /` page
  (`src/web/dashboard-page.ts`) is unchanged and still live.
