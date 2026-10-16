bump: minor

### Added
- `dashboard-app/` now has a real app shell: the LaunchPad design system
  (`@launchpad-ui/components`/`@launchpad-ui/tokens`, Apache-2.0, with a
  generated `dist/web/THIRD_PARTY_NOTICES.txt`), a header with navigation
  between `/dashboard-app/` and `/dashboard-app/configurations`
  (react-router, respecting `prefers-color-scheme`, no toggle yet), and
  typed polling hooks for the existing `GET /dashboard`/`GET
  /config-inventory` JSON endpoints (loading/loaded/stale/error states,
  abort on unmount, error backoff). Both routes are still placeholders —
  the real pages are later tasks in the same epic.
