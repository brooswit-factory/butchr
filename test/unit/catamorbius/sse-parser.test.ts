import { describe, expect, test } from "bun:test";
import { createSseParser, type ParsedSseMessage } from "../../../src/catamorbius/sse-parser.js";

function harness() {
  const messages: ParsedSseMessage[] = [];
  const retries: number[] = [];
  const comments: string[] = [];
  const parser = createSseParser({
    onMessage: (m) => messages.push(m),
    onRetry: (ms) => retries.push(ms),
    onComment: (t) => comments.push(t),
  });
  return { parser, messages, retries, comments };
}

const enc = new TextEncoder();

describe("createSseParser: basic frames", () => {
  test("retry-only frame: no message dispatched, onRetry fires", () => {
    const { parser, messages, retries } = harness();
    parser.push(enc.encode("retry: 3000\n\n"));
    expect(retries).toEqual([3000]);
    expect(messages).toEqual([]);
  });
  test("event frame: event/id/data with the optional space after colon", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode('event: com.github.push\nid: 5\ndata: {"a":1}\n\n'));
    expect(messages).toEqual([{ event: "com.github.push", id: "5", data: '{"a":1}' }]);
  });
  test("data: with NO space after the colon is also accepted", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event:x\nid:1\ndata:{}\n\n"));
    expect(messages).toEqual([{ event: "x", id: "1", data: "{}" }]);
  });
  test("multi-line data joins with \\n", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\nid: 1\ndata: line1\ndata: line2\n\n"));
    expect(messages).toEqual([{ event: "x", id: "1", data: "line1\nline2" }]);
  });
  test("comment line: reported via onComment, never a message, never resets an in-progress record", () => {
    const { parser, messages, comments } = harness();
    parser.push(enc.encode(": heartbeat\nevent: x\n: mid-record comment\nid: 1\ndata: d\n\n"));
    expect(comments).toEqual(["heartbeat", "mid-record comment"]);
    expect(messages).toEqual([{ event: "x", id: "1", data: "d" }]);
  });
  test("unknown fields are ignored, not an error", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\nid: 1\nfuture-field: whatever\ndata: d\n\n"));
    expect(messages).toEqual([{ event: "x", id: "1", data: "d" }]);
  });
  test("CRLF line endings work identically to LF", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\r\nid: 1\r\ndata: d\r\n\r\n"));
    expect(messages).toEqual([{ event: "x", id: "1", data: "d" }]);
  });
  test("multiple frames in one chunk, and across separate push() calls", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: a\nid: 1\ndata: 1\n\nevent: b\nid: 2\n"));
    parser.push(enc.encode("data: 2\n\n"));
    expect(messages).toEqual([
      { event: "a", id: "1", data: "1" },
      { event: "b", id: "2", data: "2" },
    ]);
  });
});

describe("createSseParser: chunk-boundary robustness", () => {
  test("a frame split byte-by-byte across many push() calls still parses", () => {
    const { parser, messages } = harness();
    const frame = 'event: x\nid: 1\ndata: {"k":"v"}\n\n';
    const bytes = enc.encode(frame);
    for (const b of bytes) parser.push(new Uint8Array([b]));
    expect(messages).toEqual([{ event: "x", id: "1", data: '{"k":"v"}' }]);
  });
  test("a chunk boundary landing INSIDE a multi-byte UTF-8 character is decoded correctly", () => {
    const { parser, messages } = harness();
    const frame = 'event: x\nid: 1\ndata: {"emoji":"🎉","kanji":"日本語"}\n\n';
    const bytes = enc.encode(frame);
    // Split at an arbitrary byte offset guaranteed to fall inside the 4-byte emoji sequence.
    const dataIdx = frame.indexOf('"emoji":"') + '"emoji":"'.length;
    const splitAt = new TextEncoder().encode(frame.slice(0, dataIdx)).length + 2; // 2 bytes into the 4-byte emoji
    parser.push(bytes.slice(0, splitAt));
    parser.push(bytes.slice(splitAt));
    expect(messages).toEqual([{ event: "x", id: "1", data: '{"emoji":"🎉","kanji":"日本語"}' }]);
  });
  test("a chunk boundary landing exactly between two frames", () => {
    const { parser, messages } = harness();
    const full = "event: a\nid: 1\ndata: 1\n\nevent: b\nid: 2\ndata: 2\n\n";
    const bytes = enc.encode(full);
    const mid = full.indexOf("\n\n") + 2;
    const splitBytes = enc.encode(full.slice(0, mid)).length;
    parser.push(bytes.slice(0, splitBytes));
    parser.push(bytes.slice(splitBytes));
    expect(messages).toEqual([
      { event: "a", id: "1", data: "1" },
      { event: "b", id: "2", data: "2" },
    ]);
  });
});

describe("createSseParser: truncation", () => {
  test("stream ends mid-frame (no closing blank line): dropped, never dispatched", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\nid: 1\ndata: d"));
    parser.end();
    expect(messages).toEqual([]);
  });
  test("stream ends with a dangling partial line (no trailing newline at all)", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\nid: 1\ndata: d\n\nevent: y\nid: 2\ndata: partial-no-newl"));
    parser.end();
    expect(messages).toEqual([{ event: "x", id: "1", data: "d" }]);
  });
  test("stream ends cleanly right after a blank line: nothing lost, nothing spuriously dispatched", () => {
    const { parser, messages } = harness();
    parser.push(enc.encode("event: x\nid: 1\ndata: d\n\n"));
    parser.end();
    expect(messages).toEqual([{ event: "x", id: "1", data: "d" }]);
  });
});
