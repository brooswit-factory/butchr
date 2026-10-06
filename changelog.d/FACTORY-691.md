bump: patch

### Fixed

- **`resource-mcp` gateway no longer answers a bare 401 to an
  authenticated-but-unregistered connection during startup (FACTORY-691,
  implements FACTORY-689, epic FACTORY-688).** After a daemon restart, a
  long-lived Claude session reconnecting with its still-valid persisted
  token used to get the same bare `401` as a bad credential — Claude Code
  reads that as an OAuth challenge and parks the server as failed forever.
  `ResourceConnections.handle()` now distinguishes: a connection missing
  from the in-memory registry while that agent's first `prepare()` round
  has not yet completed, with a bearer matching the token persisted on
  disk for it, gets `503` + `Retry-After: 2` + a small JSON body instead —
  everything else (wrong/missing bearer, unknown agent/name, no token
  file, or a since-retired agent whose connection is legitimately gone)
  still gets the exact same `401`, byte-for-byte, revealing nothing about
  whether the agent or server name exists.
- Every token compare (registry-hit and persisted-token paths alike) is
  now constant-time (`timingSafeEqual`), replacing a plain `!==`.
- The new unauthenticated token-file read validates both URL-derived
  `agent` and `name` before building any path — `name` against the same
  shape/reserved-word check `prepare()` already applies, `agent` by
  requiring it decode as a real agent key — so a traversal or
  reserved-name attempt is indistinguishable from any other rejected
  request.
