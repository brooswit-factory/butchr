bump: patch

### Fixed

- **`resource-mcp` gateway servers no longer park after a daemon restart,
  needing a manual `/mcp` reconnect (FACTORY-698, implements FACTORY-697,
  reported FACTORY-696).** `ResourceConnections.handle()` forwarded a
  client's `Mcp-Session-Id` straight through to the vendored MCP proxy,
  whose sessions live in a process-local map that goes empty on every
  restart — so a client presenting its pre-restart session id got a hard
  `404 "Unknown session"` forever, and the reference SDK client never
  re-initializes on that. `handle()` now treats the client's session id as
  the durable name: an unknown-but-well-formed id is adopted by running a
  gateway-initiated `initialize` + `notifications/initialized` against the
  current proxy generation, binding the client's id to the proxy's new one
  and rewriting `Mcp-Session-Id` inbound and outbound so the client never
  sees any id but its own. Concurrent requests racing to adopt the same id
  share one `initialize` call (single-flight); an upstream that is
  genuinely down (not merely a stale session) is passed straight through
  instead of being masked as a session problem.
- `GET` with no session id now answers `405`, not `400` — the one non-2xx
  status the MCP spec sanctions there, and the one the SDK client
  special-cases as "no SSE stream, carry on" instead of a fatal connection
  error.
- Any remaining error on this endpoint's JSON-RPC path now returns a JSON
  body instead of bare plain text (e.g. the proxy's own `"Unknown
  session"` / `"Initialize required"`) — the FACTORY-691 401 stays
  byte-identical.
