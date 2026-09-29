# `GET /agents/:agentKey/pty` — WebSocket PTY attach, Origin-gated

FACTORY-453 (implementing FACTORY-337, epic FACTORY-330 — "Clevr", a Chrome
extension that slides a Claude terminal into a web page, attached to the
Butchr agent working on that page's resource). FACTORY-335/FACTORY-339
answered "which agents serve this page" (`GET /resources/for-url`, see
`docs/resources-for-url.md`); this endpoint is the other half — letting a
browser tab actually attach to and drive one of those agents' terminals.

**FACTORY-464/FACTORY-465 removed `BUTCHR_EXTENSION_TOKEN` entirely** — see
"Security tradeoff" below. This endpoint is now gated on the `Origin`
allowlist alone, the exact same guard `GET /resources/for-url` uses.

## Contract

```
GET /agents/:agentKey/pty
Upgrade: websocket
Origin: chrome-extension://<id>   (REQUIRED — see Security tradeoff below)
```

`:agentKey` is one of the `agentKey` values `GET /resources/for-url` returns
(`<resourceProvider>:<ruleId>:<resourceId>`, percent-encoded per component —
see `src/rules/agent-key.ts`). The upgrade is refused (never opened) when:

| condition | result |
|---|---|
| `Origin` header ABSENT | `403` — the only credential left, so an absent one has nothing to fall back to |
| `Origin` present but not Clevr's fixed id | `403` |
| `:agentKey` does not decode as a valid agent key | `404`, `"not a valid agent key: <key>"` |
| `:agentKey` decodes fine but names no currently-live agent row | `404`, `"no such live pane: <key> (not one of this daemon's own running agents)"` — the SAME wording `/agents/pane/:pane/attach` (`src/terminal/open.ts`'s `attachRefusalMessage`) uses for an unknown pane, deliberately reused rather than reinvented |

All of the above happen in Elysia's `beforeHandle`, which runs BEFORE the
WebSocket upgrade — a refusal is an ordinary HTTP response (403/404) — the
socket is never opened at all.

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

FACTORY-497: not configurable. `Config.extensionAuth` (`src/config/config.ts`)
is always exactly Clevr's fixed extension id — the SAME allowlist
`/resources/for-url` uses — and is consumed here through
`src/web/origin-guard.ts`, the exact same mechanism, not a second one. There
is no env var left to set; a daemon whose environment still sets the old
`BUTCHR_EXTENSION_ORIGINS` gets a one-line startup warning saying so and is
otherwise unaffected (see that doc's Config section).

`/health`, `/state`, `/dashboard`, `/agents`, and `/resources/for-url` are
all unaffected by this endpoint — they remain exactly as
authenticated/unauthenticated as before this change.

## Security tradeoff (FACTORY-464/FACTORY-465)

This endpoint used to require a shared bearer token (`BUTCHR_EXTENSION_TOKEN`).
That requirement is GONE: the operator weighed the tradeoff and chose to
drop it — "one should just be able to start Clevr
and work if butchr is there." The daemon binds loopback-only
(`src/daemon/listen.ts`), and on a single-user local box, the operator judged
an Origin-allowlist-only check sufficient.

**What this does and does not protect against.** `Origin` is enforced by the
browser, so this still stops another website open in a browser tab from
reaching this endpoint. **It does NOT stop any other local process** — a
script, another user on the same box, `curl` — from setting
`Origin: chrome-extension://<allowlisted-id>` by hand and driving a live
agent's terminal; nothing here can tell that apart from the real extension.
This is accepted as reasonable for a single-user local box, not overlooked.

Because there is no longer a token to fall back to, `checkExtensionOrigin`
now refuses an ABSENT `Origin` (403) exactly like a present-but-unlisted one
— this is a change from `checkBearerOrigin`'s pre-FACTORY-465 behavior on the
plain HTTP route, which used to allow a missing `Origin` through on a valid
token alone. With the token gone, `Origin` is the only credential left on
either route, so both now use the SAME rule and the SAME guard function —
`src/web/origin-guard.ts` no longer needs a separate "strict" variant for the
WebSocket-upgrade path, because the only thing that used to distinguish it
from the plain HTTP route (the bearer token's absent-Origin exception) is
gone. Do not reintroduce a token-based bypass of the Origin check on either
route without a new, equally deliberate operator decision.

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
- **Origin gate at upgrade, never after.** A refusal is a plain HTTP
  response; the socket is never opened and then closed.
- **Nothing sensitive is logged.** No route or bridge code here logs socket
  payloads or keystrokes. (There is no longer a token to log either.)

## Files

- `src/web/origin-guard.ts` — the reusable Origin-allowlist guard
  (`checkExtensionOrigin`/`preflightExtensionOrigin`), shared verbatim with
  `GET /resources/for-url`.
- `src/config/config.ts` — the hardcoded `Config.extensionAuth` (FACTORY-497).
- `src/terminal/pty-attach.ts` — resolves `:agentKey` to a live pane (and re-checks liveness) over the dashboard snapshot; the refusal vocabulary, reusing `src/terminal/open.ts`'s wording for the "unknown/not-live" case.
- `src/terminal/pty-bridge.ts` — the pure framing/tick logic: parses client frames, decides what to send and when to close, with no socket, herdr client, or timer of its own.
- `src/web/view.ts` — the actual `.ws("/agents/:agentKey/pty", ...)` route: the `beforeHandle` Origin gate, the poll-loop wiring, back-pressure config, and the message/close handlers.
- `src/daemon/index.ts` — wires real deps: `resolvePtyPane`/`isPaneStillLive` over `dashboardFeed.snapshot()`, the new ANSI-preserving `readPaneForPty` (distinct from the detectors' ANSI-stripping `readPane`), `sendPane`, and the 250ms poll interval.
- `test/unit/origin-guard.test.ts` — unit coverage for `checkExtensionOrigin`/`preflightExtensionOrigin`, including the missing-Origin and empty-allowlist (fail-closed) cases.
- `test/unit/pty-attach.test.ts` — unit coverage for pane resolution/liveness/refusal wording.
- `test/unit/pty-bridge.test.ts` — unit coverage for frame parsing and the per-tick decision, including an ANSI-sequence-survives-a-tick case.
- `test/unit/pty-attach-route.test.ts` — end-to-end coverage over a real upgraded socket: successful attach and input/output round-trip, an ANSI escape sequence surviving the real socket byte-for-byte, a resize control frame not breaking the connection, every upgrade refusal (missing/wrong Origin, empty allowlist, malformed key, unknown/not-live key), a `herdr.pane.read` failure, and a pane disappearing between `beforeHandle` and `open`.

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
