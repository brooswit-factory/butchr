bump: patch

### Fixed
- The rules-file write lock no longer reclaims a stale `.rules.lock` left by a dead holder: it fails closed with an actionable error (which lock file, when it is safe to remove it). The previous rename-based reclaim could let two racing waiters both proceed, and its test failed intermittently on CI (FACTORY-673).
