bump: minor

### Added
- `/health` now reports a `permissionAnswer` component (inside `components[]`,
  joining the liveness AND) with the instant the permission-answer tick last
  COMPLETED — including ticks that found nothing eligible — plus `lastErrorAt`/
  `consecutiveFailures` to distinguish a rejected tick from a healthy idle one.
