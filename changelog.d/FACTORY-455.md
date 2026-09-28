bump: minor

### Added

- **`GET /agents/:agentKey/pty` now also accepts its bearer token via
  `Sec-WebSocket-Protocol` (FACTORY-455, implementing FACTORY-454, epic
  FACTORY-330).** A browser's `WebSocket` constructor cannot set
  `Authorization` on a handshake at all (measured: Chrome's
  `declarativeNetRequest` does not rewrite WebSocket upgrade headers), so
  Clevr (FACTORY-338) now opens `new WebSocket(url, ["clevr.bearer",
  "<BUTCHR_EXTENSION_TOKEN>"])`. This is checked in the SAME `beforeHandle`
  ONLY when `Authorization` is absent, reusing `checkBearerOrigin`'s own
  constant-time comparison rather than a second one. A successful
  subprotocol-authenticated handshake echoes back ONLY the fixed marker
  `clevr.bearer`, never the token. `Authorization: Bearer <token>` keeps
  working completely unchanged for curl/tests/CLI callers, and the strict
  "absent Origin is 403" rule (`checkBearerOriginForUpgrade`) is unchanged
  and applies identically to both channels. `BUTCHR_EXTENSION_TOKEN` must
  now consist only of RFC 6455-legal `Sec-WebSocket-Protocol`/HTTP-token
  characters, validated once at config load with a refusal naming any
  offending characters — never silently mangled or truncated on a request.
  See `docs/pty-attach.md` for the full contract.
