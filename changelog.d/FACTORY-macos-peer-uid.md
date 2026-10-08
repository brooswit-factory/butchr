bump: patch

### Fixed
- macOS: the same-user check on the dashboard API (`/api/rules`, `/api/session`, and every write route) always failed, because it read `/proc/net/tcp`, which macOS does not have. The Rules page showed "could not check /api/rules — peer uid check failed" and nothing could be configured from the UI. On macOS the check now reads the loopback sockets with `lsof` (always installed, no Xcode needed) and matches the same full 4-tuple as on Linux. It still fails closed if `lsof` is missing or the socket is not found.
