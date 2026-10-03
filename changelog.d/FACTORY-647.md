bump: minor

### Added

- `/health` now reports a `dashboardApp: { built, path }` field, and the daemon
  logs one `[butchr:dashboard-app]` line at startup, when the dashboard-app's
  Vite build (`dist/web`) is missing — naming the exact path and
  `bun run build:web` as the remedy. `GET /dashboard-app/*` now returns a
  friendly 503 naming the same remedy instead of a blank 404 when the build
  is absent; the old server-rendered pages (`/`, `/configurations`) are
  unaffected either way.
