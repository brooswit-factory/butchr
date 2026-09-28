# `GET /agents/:agentKey/pty` — authenticated WebSocket PTY attach

FACTORY-453 (implementing FACTORY-337, epic FACTORY-330 — "Clevr", a Chrome
extension that slides a Claude terminal into a web page, attached to the
Butchr agent working on that page's resource). FACTORY-335/FACTORY-339
answered "which agents serve this page" (`GET /resources/for-url`, see
`docs/resources-for-url.md`); this endpoint is the other half — letting a
browser tab actually attach to and drive one of those agents' terminals.

## Contract

```
GET /agents/:agentKey/pty
Upgrade: websocket
Authorization: Bearer <BUTCHR_EXTENSION_TOKEN>
Origin: chrome-extension://<id>   (REQUIRED here — see Security below)
```

`:agentKey` is one of the `agentKey` values `GET /resources/for-url` returns
(`<resourceProvider>:<ruleId>:<resourceId>`, percent-encoded per component —
see `src/rules/agent-key.ts`). The upgrade is refused (never opened) when:

| condition | result |
|---|---|
| `BUTCHR_EXTENSION_TOKEN` unset | `503`, endpoint disabled entirely |
| `Origin` header ABSENT | `403` |
| `Origin` present but not in `BUTCHR_EXTENSION_ORIGINS` | `403` |
| `Authorization` missing | `401` |
| `Authorization` wrong | `401` |
| `:agentKey` does not decode as a valid agent key | `404`, `"not a valid agent key: <key>"` |
| `:agentKey` decodes fine but names no currently-live agent row | `404`, `"no such live pane: <key> (not one of this daemon's own running agents)"` — the SAME wording `/agents/pane/:pane/attach` (`src/terminal/open.ts`'s `attachRefusalMessage`) uses for an unknown pane, deliberately reused rather than reinvented |

All of the above happen in Elysia's `beforeHandle`, which runs BEFORE the
WebSocket upgrade — a refusal is an ordinary HTTP response, and the socket
is never opened at all.

Once open, the pane the socket attached to is re-checked on every poll tick
against the SAME staffed-agent registry the initial resolve used. If it goes
away (the agent stops, is replaced under the same key, or herdr's own read
fails), the socket is closed with:

```
code: 4000
reason: "agent gone: pane no longer live"
```

so a client can tell "the agent is gone" apart from an ordinary network
drop, close, or server restart.

## Message framing

Distinguished by the WebSocket frame's own OPCODE, not by sniffing content —
a raw keystroke someone actually types could otherwise coincidentally look
like a control message:

| direction | frame type | meaning |
|---|---|---|
| socket → browser | TEXT | a full snapshot of the pane's current on-screen contents (see "Output: snapshot, not a stream" below) |
| browser → socket | TEXT | raw keystroke input, forwarded to the pane verbatim via `herdr.pane.sendText` |
| browser → socket | BINARY | a control message: UTF-8 JSON, currently only `{"type":"resize","cols":<positive int>,"rows":<positive int>}` |

A BINARY frame that isn't valid JSON, or whose shape isn't recognized, is
silently ignored rather than closing the connection — forward-compatible, so
a future control-message kind (or a malformed frame from a flaky client)
never tears down an otherwise-healthy session over one bad frame.

### Output: a polled snapshot, not a byte stream

`@brooswit/herdr-sdk`'s pane service (`PaneService`, checked against the
version this repo pins) has no subscribe-to-output call and no way to attach
to a pane's PTY as a byte stream: `herdr.pane.read` is the only way to get
pane text, and it always returns a full snapshot, never a delta. herdr's
push-event channel (`events.subscribe`) has no "output changed" event
carrying bytes either — `pane.output_matched` needs a search pattern (built
for waiting on specific output, not general streaming) and `pane.exited`
cannot be filtered to one pane at all. So this endpoint polls
`herdr.pane.read` on a short interval (`pollMs`, currently 250ms — fast
enough to feel interactive, far above herdr's own per-call cost to matter as
load) — the acceptable fallback the epic named, used here because it was
checked and found necessary, not defaulted to.

**Each TEXT output frame is the pane's WHOLE current snapshot, not a diff.**
An earlier version of this endpoint tried to send only the newly-appended
suffix between polls. That is wrong for a real terminal: a Claude session's
output is heavily cursor-addressed (it repaints regions of the screen in
place, moves the cursor, clears and redraws), so "new text since last read"
is not a coherent idea — a repaint is not an append, and there is no safe
way to diff two ANSI-bearing strings and produce a fragment a terminal
emulator could replay correctly. So the honest framing is: **this polls a
snapshot and expects the client to render each message as a full-screen
redraw**, not "streams the pane". A frame is only sent when the snapshot
differs at all (byte-for-byte) from the last one sent, so an unchanged
screen between polls costs nothing.

**ANSI is preserved, never stripped.** The daemon's existing pane-read
helper (`readPane` in `src/daemon/index.ts`, used by detectors) passes
`strip_ansi: true` — correct for a detector that wants plain text, wrong
here: FACTORY-338 puts xterm.js on the other end of this socket, and
ANSI-stripped output has no colour, no cursor positioning, no redraw — a
dead scrolling text dump, not a terminal. This endpoint's own read
(`readPaneForPty` in `src/daemon/index.ts`) instead calls `herdr.pane.read`
with `source: "visible"` (the pane's current on-screen contents, matching
what a real terminal shows — not the detectors' `"detection"` source),
`format: "ansi"`, and `strip_ansi: false`. An ANSI cursor-positioning/color
escape sequence is verified to survive the full round trip, over a real
socket, byte-for-byte (`test/unit/pty-attach-route.test.ts`).

### Resize

A resize control message is parsed and accepted — a client sending one never
breaks the connection — but **it is not currently wired through to
anything**. `PaneService.resize` exists in herdr's SDK, but its params
(`{ direction, amount, pane_id }`) grow or shrink a pane's SPLIT within
herdr's own window layout — a completely different resource from the PTY's
own column/row count. There is no herdr call anywhere in this SDK that sets
a pane's PTY size. This is a documented gap, not a silent drop: a resized
browser panel does not currently change the remote program's terminal-size
idea. Revisiting this needs either a herdr SDK addition or a different
mechanism entirely; it is out of this ticket's scope to invent one.

### Back-pressure

The WebSocket is opened with Bun's native `backpressureLimit: 4 * 1024 *
1024` (4 MB) and `closeOnBackpressureLimit: true`: once a slow client's own
unread send buffer exceeds that bound, the connection is dropped outright.
This was chosen over silently dropping old output because a terminal
emulator has no way to know it missed a frame — a dropped snapshot would
leave the client's screen wrong with no signal anything went stale. A hard
disconnect is an honest, visible failure a client can reconnect from
instead.

## Config

| env var | required | effect |
|---|---|---|
| `BUTCHR_EXTENSION_TOKEN` | to enable the endpoint | the SAME shared bearer token `GET /resources/for-url` uses. **UNSET means the endpoint is DISABLED (503 on every upgrade attempt), never open.** No second token, no second env var. |
| `BUTCHR_EXTENSION_ORIGINS` | no | the SAME comma-separated `chrome-extension://<id>` allowlist `/resources/for-url` uses. |

Both are read once into `Config.extensionAuth` (`src/config/config.ts`) and
consumed here through `src/web/bearer-origin-guard.ts` — the exact same
mechanism `/resources/for-url` uses, not a second one.

`/health`, `/state`, `/dashboard`, `/agents`, and `/resources/for-url` are
all unaffected by this endpoint — they remain exactly as
authenticated/unauthenticated as before this change.

## WHY the Origin rule is STRICTER here than `/resources/for-url`'s

`checkBearerOrigin` (the guard `/resources/for-url` uses) deliberately
**allows a request with no `Origin` header at all** — it only rejects an
Origin that is present and not allowlisted. That is correct and deliberate
for an ordinary cross-origin `fetch()`: a browser always sends `Origin` on
one, and CORS handles the rest, so there is no way for an unlisted page to
make that specific request succeed.

**That reasoning does not hold for a WebSocket upgrade, because browsers do
not apply CORS to WebSockets.** An Origin-less upgrade is exactly what ANY
page the user has open could send — there is no CORS backstop catching it.
Calling `checkBearerOrigin` verbatim on this endpoint's upgrade path would
accept that request and hand it a live, keystroke-capable terminal socket.

So this endpoint uses `checkBearerOriginForUpgrade`
(`src/web/bearer-origin-guard.ts`), a strict sibling that refuses an ABSENT
`Origin` (403) exactly like a present-but-not-allowlisted one, before the
token is ever inspected. **Do not "simplify" this route to reuse
`checkBearerOrigin` directly, and do not "harmonize" the two routes' Origin
rules to match** — they differ on purpose, because one is CORS-covered and
the other structurally cannot be. `test/unit/bearer-origin-guard.test.ts`
and `test/unit/pty-attach-route.test.ts` both cover the missing-Origin case
specifically, separately from the wrong-Origin case (a different code path
and a different bug class).

## Security model, summarized

- **Attach only.** No endpoint, parameter, or message can run an arbitrary
  command, choose an arbitrary program, or name an arbitrary PTY path — the
  only reachable targets are panes this daemon already started for its own
  agents, resolved via the same staffed-agent dashboard snapshot
  `/resources/for-url` reads (`src/terminal/pty-attach.ts`'s
  `resolvePtyPane`), never a raw pane id taken uninterpreted from client
  input.
- **No new I/O to resolve the initial pane, or to re-check liveness on each
  poll tick.** Both read the same already-polled `dashboardFeed.snapshot()`
  every other route in `src/daemon/index.ts` reads — never a fresh provider
  call.
- **Token/Origin gate at upgrade, never after.** A refusal is a plain HTTP
  response; the socket is never opened and then closed.
- **Nothing sensitive is logged.** No route or bridge code here logs token
  values, socket payloads, or keystrokes.

## Files

- `src/web/bearer-origin-guard.ts` — adds `checkBearerOriginForUpgrade`, the strict Origin-required sibling of `checkBearerOrigin`.
- `src/terminal/pty-attach.ts` — resolves `:agentKey` to a live pane (and re-checks liveness) over the dashboard snapshot; the refusal vocabulary, reusing `src/terminal/open.ts`'s wording for the "unknown/not-live" case.
- `src/terminal/pty-bridge.ts` — the pure framing/tick logic: parses client frames, decides what to send and when to close, with no socket, herdr client, or timer of its own.
- `src/web/view.ts` — the actual `.ws("/agents/:agentKey/pty", ...)` route: the `beforeHandle` auth+resolve gate, the poll-loop wiring, back-pressure config, and the message/close handlers.
- `src/daemon/index.ts` — wires real deps: `resolvePtyPane`/`isPaneStillLive` over `dashboardFeed.snapshot()`, the new ANSI-preserving `readPaneForPty` (distinct from the detectors' ANSI-stripping `readPane`), `sendPane`, and the 250ms poll interval.
- `test/unit/bearer-origin-guard.test.ts` — unit coverage for `checkBearerOriginForUpgrade`, including the missing-Origin case.
- `test/unit/pty-attach.test.ts` — unit coverage for pane resolution/liveness/refusal wording.
- `test/unit/pty-bridge.test.ts` — unit coverage for frame parsing and the per-tick decision, including an ANSI-sequence-survives-a-tick case.
- `test/unit/pty-attach-route.test.ts` — end-to-end coverage over a real upgraded socket: successful attach and input/output round-trip, an ANSI escape sequence surviving the real socket byte-for-byte, a resize control frame not breaking the connection, every upgrade refusal (missing token, wrong token, token unset, missing Origin, wrong Origin, malformed key, unknown/not-live key), a `herdr.pane.read` failure, a pane disappearing between `beforeHandle` and `open`, and the pane-disappearing close reason.

## A related, inherent limitation worth documenting here

FACTORY-336's merged extension panel stops keystrokes from escaping to the
host page via `stopPropagation` on the shadow host. That handles the common
case, but a host page that registers its shortcut handler in the CAPTURE
phase on `document` will still see the key, because capture runs
ancestor-first and nothing at the shadow host can prevent it. This is
inherent to how the DOM's capture phase works, not a defect in the panel or
in this transport — it is simply invisible until a real terminal (this
endpoint) is in the panel, at which point a host page with a capture-phase
shortcut (e.g. `Ctrl+K` for its own command palette) can steal a keystroke a
person meant for the terminal. FACTORY-338 owns the panel side of this; this
transport-level fact is recorded here since it is where a reader is most
likely to be debugging "why did my keystroke not reach the terminal".
