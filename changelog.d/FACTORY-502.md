---
bump: patch
---

### Fixed

- **The extension-origin rejection journal (`[origin-guard]`, FACTORY-476) is now bounded against flooding.** Its dedupe key used to include the raw request path, so an attacker could vary the `GET /agents/:agentKey/pty` upgrade route's own agent key on every request and get a fresh dedupe key — and a fresh journal line — each time, unbounded. Four independent bounds now hold: (1) the dedupe key and the printed line use the request's ROUTE PATTERN, never a raw, attacker-controlled path segment — an unrecognized route shape fails closed to one fixed bucket rather than being passed through raw; (2) a global cap on lines emitted per window, with a single `suppressed=N` line reporting what was dropped once the window ends, itself rate-limited to at most one per window; (3) a hard cap on the dedupe map's own size, enforced on insert; (4) the map's self-pruning now stops at the first still-live entry rather than scanning every call. Allowed requests still log nothing.
