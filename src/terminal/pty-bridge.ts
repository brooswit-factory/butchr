/**
 * FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the pure
 * decision logic behind `GET /agents/:agentKey/pty`'s WebSocket bridge,
 * split out of `src/web/view.ts`'s route wiring so it is testable without a
 * real socket, a real herdr client, or a real timer.
 *
 * FRAMING (both directions), chosen to be distinguishable by the WebSocket
 * frame's own OPCODE rather than by sniffing content, since a raw keystroke
 * a person actually types could otherwise coincidentally look like a
 * control message:
 *   - TEXT frame  == raw pane bytes: keystroke input going in (forwarded to
 *     the pane verbatim), pane output going out.
 *   - BINARY frame == a control message: currently only
 *     `{"type":"resize","cols":N,"rows":N}`, UTF-8-encoded JSON. Any other
 *     shape, or a binary frame that isn't valid JSON, is ignored rather than
 *     closing the connection — see `parseClientFrame`'s own doc comment.
 *
 * NO RAW STREAMING PRIMITIVE: `@brooswit/herdr-sdk`'s pane service (checked
 * against the installed version, `PaneService` in
 * `node_modules/@brooswit/herdr-sdk/dist/services/pane.d.ts`) has no
 * subscribe-to-output call and no way to attach to a pane's PTY as a byte
 * stream — `herdr.pane.read` is the only way to get pane text, and it always
 * returns a full snapshot, never a delta. herdr's `events.subscribe` push
 * channel (`generated/params.d.ts`'s `Subscription` union) has no
 * "output changed" event carrying bytes either: `pane.output_matched`
 * requires a search pattern (built for waiting on specific output, not
 * general streaming) and `pane.exited` cannot be filtered to one pane_id at
 * all. So this bridge polls `herdr.pane.read` on a short interval — the
 * fallback the ticket names as acceptable when checked and found necessary,
 * not defaulted to.
 *
 * FULL-SNAPSHOT REDRAW, NOT A DIFF (FACTORY-330's own correction on this
 * ticket, 2026-09-28): an earlier version of this module tried to diff
 * consecutive reads and send only the new suffix. That is wrong for a real
 * terminal: `herdr.pane.read` is read here WITHOUT stripping ANSI (`format:
 * "ansi", strip_ansi: false` — see `src/daemon/index.ts`'s `ptyAttach.read`
 * wiring), because FACTORY-338 puts xterm.js on the other end of this
 * socket, and ANSI-stripped output has no colour, no cursor positioning, no
 * redraw — a dead scrolling text dump, not a terminal. A Claude session's
 * output is heavily cursor-addressed (it repaints regions of the screen in
 * place), so "new text since last read" is not a coherent idea once ANSI is
 * in play: a repaint is not an append, and there is no safe way to diff two
 * ANSI-bearing strings and produce a fragment a terminal emulator could
 * replay correctly. So each tick sends the CURRENT FULL SNAPSHOT of the pane
 * whenever it differs from the last snapshot sent (byte-for-byte unequal —
 * cheap, and never mis-fires on a truly unchanged screen), and the client is
 * expected to render each message as a full-screen redraw, not append it.
 * This is deliberately the more honest framing: "poll a snapshot and redraw
 * it", not "stream the pane".
 *
 * NO PTY RESIZE PRIMITIVE EITHER: `PaneService.resize` exists, but
 * `PaneResizeParams` (`generated/params.d.ts`) is `{ direction, amount,
 * pane_id }` — it grows or shrinks a PANE'S SPLIT within herdr's own window
 * layout, a completely different resource from the PTY's own column/row
 * count. There is no herdr call anywhere in this SDK that sets a pane's PTY
 * size. A resize control message is therefore parsed and accepted (so a
 * client sending one never breaks the connection) but not wired through to
 * anything — see `docs/pty-attach.md`'s Config/Contract sections for this
 * stated as a documented gap, not a silent drop.
 */

/** A parsed BINARY control frame. Currently only one kind exists. */
export type PtyControlMessage = { type: "resize"; cols: number; rows: number };

export type PtyClientFrame = { kind: "input"; text: string } | { kind: "control"; message: PtyControlMessage } | { kind: "ignored" };

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * TEXT frames are always raw input, verbatim, never parsed. BINARY frames
 * are always control messages: UTF-8-decoded and JSON-parsed, and anything
 * that isn't `{"type":"resize","cols":<positive int>,"rows":<positive int>}`
 * is `"ignored"` rather than fatal — a forward-compatible choice, so a
 * client sending a future control message kind an older daemon doesn't know
 * about (or a malformed one from a flaky client) never tears down an
 * otherwise-healthy session over one bad frame.
 */
export function parseClientFrame(message: string | Uint8Array): PtyClientFrame {
  if (typeof message === "string") return { kind: "input", text: message };
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(message));
  } catch {
    return { kind: "ignored" };
  }
  if (
    decoded !== null &&
    typeof decoded === "object" &&
    (decoded as Record<string, unknown>)["type"] === "resize" &&
    isPositiveInt((decoded as Record<string, unknown>)["cols"]) &&
    isPositiveInt((decoded as Record<string, unknown>)["rows"])
  ) {
    const { cols, rows } = decoded as { cols: number; rows: number };
    return { kind: "control", message: { type: "resize", cols, rows } };
  }
  return { kind: "ignored" };
}

export interface PtyTickState {
  lastText: string;
}

export type PtyTickResult =
  | { kind: "output"; text: string; state: PtyTickState }
  | { kind: "idle"; state: PtyTickState }
  | { kind: "closed"; reason: string };

/** The distinguishable close reason sent when the pane goes away mid-session — see `docs/pty-attach.md`'s Contract section for the exact code/reason pair this maps to on the wire. */
export const PTY_CLOSED_REASON = "agent gone: pane no longer live";

/**
 * One poll tick's pure decision: given the running state, whether the pane
 * is STILL live (per `isPaneStillLive`, checked against the daemon's own
 * already-polled dashboard snapshot — no extra I/O of its own), and this
 * tick's fresh, UN-ANSI-stripped `herdr.pane.read` text, decide what (if
 * anything) to send and whether to close.
 *
 * Liveness is checked BEFORE the fresh text is trusted: once a pane is
 * gone, whatever text a read happened to return is irrelevant — the socket
 * closes either way. When live, the WHOLE fresh text is the message to send
 * (see this module's own header for why this is a full-snapshot redraw, not
 * a diff) — but only when it differs at all from the last snapshot actually
 * sent, so an unchanged screen between two polls costs no wasted frame.
 */
export function ptyTick(state: PtyTickState, live: boolean, freshText: string): PtyTickResult {
  if (!live) return { kind: "closed", reason: PTY_CLOSED_REASON };
  if (freshText === state.lastText) return { kind: "idle", state };
  return { kind: "output", text: freshText, state: { lastText: freshText } };
}
