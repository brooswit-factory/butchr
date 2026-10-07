bump: patch

### Fixed

- **`resource-mcp` gateway survives a reconnecting MCP client's real ~8s
  retry budget after a daemon restart (FACTORY-703, implements FACTORY-702,
  epic FACTORY-696).** FACTORY-700 measured the real `claude` CLI (v2.1.251):
  on a `503` it makes the initial POST plus exactly 3 retries at ~1s/2s/4s
  (the last at t≈7.8s), then marks the server failed and sends nothing
  further for the rest of its retry window — a retry-exhausted `503` falls
  into the client's generic `CLIENT_HTTP_NOT_IMPLEMENTED` fallback, the same
  label reported against this bug. `ResourceConnections.prepare()` used to
  prepare one agent's multiple `resource_*` servers **serially**, each with
  its own up-to-20s `proxy.ready` timeout — a 3-server agent could take up
  to ~60s, far longer than the client's ~8s patience. It now prepares them
  **concurrently** (`Promise.allSettled`, not a serial loop), cutting that
  worst case to one server's own timeout (~20s) regardless of how many
  servers the agent has.
  `ResourceConnections.handle()` also now **holds** an otherwise-503-worthy
  request (bounded by a new `requestHoldMs`, default 25s) while that
  agent's `prepare()` round is genuinely in flight, instead of answering
  `503` immediately — a reconnecting client's single in-flight request can
  then resolve directly to success once `prepare()` finishes, rather than
  needing to survive being told to retry at all. Bounded: if `prepare()`
  is still running once `requestHoldMs` elapses, the pre-existing `503` +
  `Retry-After` behaviour is the fallback; if the round has genuinely
  finished without this connection (the agent's `prepare()` failed, or the
  global startup backstop elapsed with none in flight), the response is the
  same `401` as any other absent-and-ready connection.
- **Fixed the 503→401 cliff** (FACTORY-700's own regression test): `isReady()`
  used to flip an agent straight to `401` once the global `startupDeadlineMs`
  backstop elapsed, with no regard for whether that agent's own `prepare()`
  was still genuinely running — a merely-slow agent could become
  permanently unauthorized. A new `inFlightPrepares` set suppresses the
  deadline arm for exactly as long as a round is actually in flight; the
  deadline still applies, unchanged, to an agent whose `prepare()` was
  never re-invoked in this instance at all (e.g. a retired agent whose
  token file is still on disk) — FACTORY-688/689/691's `retain(new Set())`
  → `401` guarantee, and every 401 byte-identity property, are unchanged.
- **Corrects FACTORY-691's changelog entry above**: for the real `claude`
  CLI v2.1.251, a bare `401` with a static `Authorization` header does
  **not** read as an OAuth challenge — the client shows a distinct,
  explicit "Server rejected the configured Authorization header (HTTP 401)"
  message and does not retry. That claim was measured and found false by
  FACTORY-700; recorded here since nothing else corrects it in the
  changelog itself.
