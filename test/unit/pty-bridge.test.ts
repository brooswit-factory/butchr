import { describe, expect, test } from "bun:test";
import { parseClientFrame, ptyTick, PTY_CLOSED_REASON } from "../../src/terminal/pty-bridge.js";

describe("parseClientFrame", () => {
  test("a TEXT frame is always raw input, verbatim, never parsed as JSON", () => {
    expect(parseClientFrame("hello world")).toEqual({ kind: "input", text: "hello world" });
    expect(parseClientFrame('{"type":"resize","cols":80,"rows":24}')).toEqual({
      kind: "input",
      text: '{"type":"resize","cols":80,"rows":24}',
    });
  });

  test("a TEXT frame carrying an ANSI escape sequence is passed through byte-for-byte, never sanitized", () => {
    const withAnsi = "[31mred[0m and [1;1H(cursor home)";
    expect(parseClientFrame(withAnsi)).toEqual({ kind: "input", text: withAnsi });
  });

  test("a BINARY frame containing a well-formed resize control message is parsed", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(parseClientFrame(bytes)).toEqual({ kind: "control", message: { type: "resize", cols: 80, rows: 24 } });
  });

  test("a BINARY frame that isn't valid JSON is ignored, not fatal", () => {
    expect(parseClientFrame(new TextEncoder().encode("not json"))).toEqual({ kind: "ignored" });
  });

  test("a BINARY frame with a recognized shape but non-positive-integer dimensions is ignored", () => {
    for (const bad of [{ type: "resize", cols: 0, rows: 24 }, { type: "resize", cols: 80, rows: -1 }, { type: "resize", cols: 1.5, rows: 24 }, { type: "resize", cols: "80", rows: 24 }]) {
      expect(parseClientFrame(new TextEncoder().encode(JSON.stringify(bad)))).toEqual({ kind: "ignored" });
    }
  });

  test("a BINARY frame with an unrecognized type is ignored", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "run", command: "rm -rf /" }));
    expect(parseClientFrame(bytes)).toEqual({ kind: "ignored" });
  });
});

describe("ptyTick — full-snapshot redraw, not a diff (FACTORY-330's own correction, 2026-09-28)", () => {
  test("live with changed text: emits the WHOLE new snapshot (not a suffix/delta) and advances state", () => {
    const r = ptyTick({ lastText: "abc" }, true, "abcdef");
    expect(r).toEqual({ kind: "output", text: "abcdef", state: { lastText: "abcdef" } });
  });

  test("a non-append change (cursor-addressed repaint, e.g. a screen clear) still sends the full new snapshot, never a diff artifact", () => {
    const r = ptyTick({ lastText: "abc" }, true, "xyz");
    expect(r).toEqual({ kind: "output", text: "xyz", state: { lastText: "xyz" } });
  });

  test("live with byte-for-byte unchanged text: idle, state unchanged, no wasted frame", () => {
    const r = ptyTick({ lastText: "abc" }, true, "abc");
    expect(r).toEqual({ kind: "idle", state: { lastText: "abc" } });
  });

  test("not live: closed with the distinguishable reason, regardless of what text was read", () => {
    const r = ptyTick({ lastText: "abc" }, false, "anything");
    expect(r).toEqual({ kind: "closed", reason: PTY_CLOSED_REASON });
  });

  // FACTORY-337's ANSI FIDELITY requirement: "bytes arrived" is not
  // evidence a terminal will work — a cursor-positioning/color escape
  // sequence must survive the round trip INTACT, byte-for-byte, since
  // `ptyTick` is the one place a diff could have mangled it (the earlier,
  // superseded version of this module diffed consecutive reads).
  test("an ANSI cursor-positioning + color sequence survives a tick completely unmodified", () => {
    const frame1 = "[2J[1;1H[31mred text[0m";
    const r1 = ptyTick({ lastText: "" }, true, frame1);
    expect(r1).toEqual({ kind: "output", text: frame1, state: { lastText: frame1 } });

    // A cursor-addressed repaint (moves the cursor and overwrites in place)
    // rather than an appended line — exactly the case a diff would mangle.
    const frame2 = "[2J[1;1H[32mgreen text[0m";
    const r2 = ptyTick(r1.kind === "output" ? r1.state : { lastText: "" }, true, frame2);
    expect(r2).toEqual({ kind: "output", text: frame2, state: { lastText: frame2 } });
  });
});
