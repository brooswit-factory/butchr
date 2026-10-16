/**
 * FACTORY-134 (task 1/2 of story FACTORY-22): a minimal, incremental
 * server-sent-events frame parser over raw byte chunks — no dependency on
 * the `eventsource` package (see docs/catamorbius-push.md for why a small
 * parser over `fetch` was chosen instead: header auth needs a fetch-based
 * transport either way, and the wire format this gateway emits is narrow
 * enough that reimplementing just it is simpler than adapting a general
 * EventSource polyfill to a custom transport).
 *
 * ROBUSTNESS THIS PARSER MUST HAVE (FACTORY-134's own Definition of done):
 * - Frames split at ARBITRARY chunk boundaries, including inside a
 *   multi-byte UTF-8 character: `push` feeds each chunk through a
 *   `TextDecoder` in STREAMING mode (`{stream: true}`), which itself
 *   buffers a dangling incomplete byte sequence until the next chunk
 *   supplies its continuation — this module never decodes a chunk in
 *   isolation.
 * - CRLF or LF line endings: `\r\n` and `\n` both split a line; a bare
 *   trailing `\r` is stripped.
 * - `data:` with or without the one optional space after the colon.
 * - Multi-line `data:` — each line appends to an array, joined with `\n`
 *   at dispatch (mirrors the SSE spec's own multi-line `data` behavior).
 * - Comment lines (`:...`) — reported via `onComment`, never accumulated
 *   into a dispatched message's fields, and never themselves reset an
 *   in-progress record.
 * - Unknown fields — ignored, not an error (the gateway's frame format is
 *   fixed today, but a forward-compatible field must not break parsing).
 * - A stream that ends mid-frame: `end()` NEVER dispatches whatever was
 *   accumulated but not yet terminated by a blank line — it is dropped
 *   silently, per this ticket's explicit requirement ("a truncated final
 *   frame is dropped, never delivered").
 *
 * WHAT THIS PARSER DELIBERATELY DOES NOT DO: it has no notion of "last
 * event id" persistence across records (real `EventSource` carries an id
 * forward when a later record omits one) — this gateway always sends `id:`
 * on every real event frame (per its README), so every dispatched
 * `onMessage` call reports exactly the `id` (if any) THAT record itself
 * carried, nothing inherited. `client.ts` is the layer that tracks the
 * connection's own last-delivered seq.
 */

export interface ParsedSseMessage {
  /** The `event:` field's value, verbatim. `undefined` for a record with no `event:` line (e.g. a bare `retry:`-only control frame never reaches `onMessage` at all — see below). */
  event?: string;
  /** The `id:` field's value, verbatim (a string — numeric parsing is the caller's job). `undefined` when absent. */
  id?: string;
  /** Every `data:` line's value, joined with `\n`. `""` when no `data:` line was present but the record still had an `event:` or `id:` field (dispatched anyway, per the SSE spec: a record needs at least one meaningful field to dispatch, not specifically `data`). */
  data: string;
}

export interface SseParserCallbacks {
  /** Fired once per blank-line-terminated record that carried an `event:` and/or `id:` and/or `data:` field. A record with ONLY a `retry:` field (this gateway's very first frame) never reaches here — see `onRetry`. */
  onMessage(msg: ParsedSseMessage): void;
  /** Fired the instant a `retry:` field is parsed (a valid non-negative integer) — applies immediately, independent of whether the record it's part of also dispatches a message. */
  onRetry(ms: number): void;
  /** Fired for every comment line (`:...`), text with the leading `:` and one optional following space stripped. The gateway's heartbeat (`: heartbeat`) arrives here. */
  onComment(text: string): void;
}

export interface SseParser {
  /** Feed one chunk of raw bytes off the response body's reader. */
  push(chunk: Uint8Array): void;
  /** Signal the stream has ended. Flushes the UTF-8 decoder; any unterminated trailing line or in-progress (no blank line yet) record is discarded, never dispatched. */
  end(): void;
}

/** Creates a fresh, single-stream parser — one instance per connection attempt (never reused across a reconnect: a new TCP/HTTP stream starts a new decoder and a new field-accumulation state). */
export function createSseParser(callbacks: SseParserCallbacks): SseParser {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let curEvent: string | undefined;
  let curId: string | undefined;
  let curData: string[] = [];
  let curHasField = false;

  function resetRecord(): void {
    curEvent = undefined;
    curId = undefined;
    curData = [];
    curHasField = false;
  }

  function dispatchIfAny(): void {
    if (curHasField) {
      const msg: ParsedSseMessage = { data: curData.join("\n") };
      if (curEvent !== undefined) msg.event = curEvent;
      if (curId !== undefined) msg.id = curId;
      callbacks.onMessage(msg);
    }
    resetRecord();
  }

  function processLine(line: string): void {
    if (line === "") {
      dispatchIfAny();
      return;
    }
    if (line.startsWith(":")) {
      const text = line.slice(1).startsWith(" ") ? line.slice(2) : line.slice(1);
      callbacks.onComment(text);
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        curEvent = value;
        curHasField = true;
        break;
      case "id":
        curId = value;
        curHasField = true;
        break;
      case "data":
        curData.push(value);
        curHasField = true;
        break;
      case "retry": {
        const ms = Number(value);
        if (Number.isFinite(ms) && ms >= 0) callbacks.onRetry(ms);
        break;
      }
      default:
        // Unknown field: ignored, per this module's own header.
        break;
    }
  }

  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    },
    end(): void {
      // Flush the decoder's own dangling bytes (a stream truncated mid
      // multi-byte character decodes to a Unicode replacement char here,
      // never thrown — TextDecoder's default, non-fatal mode).
      buffer += decoder.decode();
      // Whatever remains — an unterminated trailing line, and/or a record
      // with fields already accumulated but no closing blank line — is
      // deliberately DROPPED, never dispatched: this is the "truncated
      // final frame" case this ticket requires never be delivered.
      buffer = "";
      resetRecord();
    },
  };
}
