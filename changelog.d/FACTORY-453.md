---
bump: minor
---

### Added

- **`GET /agents/:agentKey/pty` — an authenticated WebSocket that lets a browser attach to and drive a live agent's terminal.** Keyed by the same `agentKey` `GET /resources/for-url` returns, gated by the same `BUTCHR_EXTENSION_TOKEN`/`BUTCHR_EXTENSION_ORIGINS` bearer/origin guard — with one deliberate difference from that sibling route: an upgrade with no `Origin` header is refused, because CORS does not protect a WebSocket the way it protects an ordinary cross-origin fetch. Output is a polled, ANSI-preserving snapshot of the pane's current screen (not a byte stream — herdr exposes no streaming primitive, and a full-screen redraw is the honest framing once ANSI cursor-addressing is in play); input is forwarded to the pane verbatim. A resize control message is accepted but not yet wired through (herdr has no PTY-resize primitive, only an unrelated pane-split resize). The socket closes with a distinguishable reason when the pane goes away, and disconnects a client outright if it can't keep up with output rather than silently dropping frames. See `docs/pty-attach.md` for the full contract.
