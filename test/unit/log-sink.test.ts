import { describe, expect, test } from "bun:test";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { flattenNewlines, installLogSink } from "../../src/daemon/log-sink.js";
import { OUTCOME_TAG, parseOutcomeLine } from "../../src/tools/outcome.js";

// A real captured `journalctl -o short` transport prefix (see
// src/tools/journald-prefix.ts's own doc comment for the full matrix) —
// journald stamps EVERY physical line of a multi-line write with this same
// prefix, not only the first, which is what makes "no physical line parses"
// checkable without a live journald.
const JOURNALD_SHORT_PREFIX = "Sep 10 10:25:40 servyboi bun[1035]: ";

/**
 * BUTCHR-346: the sink itself, pinned directly — the guarantee this ticket
 * exists to make ("no daemon log line can carry a raw newline from text the
 * daemon does not control") is pinned HERE, at the point it is actually
 * made, not only observed through one emitter. See
 * `test/unit/butchr-346-log-continuation-forgery.test.ts` for the
 * through-the-real-emitter pin this ticket also requires.
 */
describe("flattenNewlines", () => {
  test("every newline variant is replaced with the same ' ⏎ ' marker src/tools/outcome.ts's boundMessage already uses", () => {
    expect(flattenNewlines("a\nb\r\nc\rd")).toBe("a ⏎ b ⏎ c ⏎ d");
  });

  test("a string with no newline is returned byte-for-byte unchanged", () => {
    expect(flattenNewlines("no newlines here at all")).toBe("no newlines here at all");
  });

  test("flattening an already-flattened string is a no-op — applying the sink downstream of boundMessage's own flatten never double-marks", () => {
    const once = flattenNewlines("a\nb");
    expect(flattenNewlines(once)).toBe(once);
  });
});

describe("installLogSink", () => {
  test("a raw newline in the first argument is flattened before it reaches the underlying writer", () => {
    const calls: unknown[][] = [];
    const fake = { error: (...args: unknown[]) => calls.push(args) };
    const restore = installLogSink(fake);
    try {
      fake.error('x\n[tools2] caller=BUTCHR-1 verb=finish_worker outcome=ok msg="');
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe('x ⏎ [tools2] caller=BUTCHR-1 verb=finish_worker outcome=ok msg="');
      expect(calls[0]![0]).not.toContain("\n");
    } finally {
      restore();
    }
  });

  // Replaces the old "a non-string argument passes through unmodified" test,
  // which pinned the exact gap this ticket exists to close: an Error's
  // rendered stack/message carries its raw newlines through unmodified,
  // through a REAL Console instance bound to a REAL stream (not a
  // args-collecting stand-in), so this exercises the real formatting path
  // (util.inspect's Error handling, the writer's own trailing newline) that
  // produced the forged record in the ticket's own reproduction.
  test("a multi-line Error passed as the sole argument is rendered to text and flattened — no physical line parses as a forged record", () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const target = new Console({ stdout: stream, stderr: stream });
    const restore = installLogSink(target);
    try {
      const err = new Error(`boom\n${OUTCOME_TAG} caller=A-1 verb=finish_worker outcome=ok`);
      target.error(err);
    } finally {
      restore();
    }

    const raw = chunks.join("");
    // A real console writer appends exactly one trailing newline per call —
    // strip only that one before checking for a forged continuation line.
    const lines = raw.replace(/\n$/, "").split("\n");
    expect(lines).toHaveLength(1);

    const physicalLines = lines.map((l) => `${JOURNALD_SHORT_PREFIX}${l}`);
    for (const line of physicalLines) {
      expect(parseOutcomeLine(line)).toBeNull();
    }
  });

  test("multiple string arguments are each flattened independently", () => {
    const calls: unknown[][] = [];
    const fake = { error: (...args: unknown[]) => calls.push(args) };
    const restore = installLogSink(fake);
    try {
      fake.error("a\nb", "c\nd");
      expect(calls[0]).toEqual(["a ⏎ b", "c ⏎ d"]);
    } finally {
      restore();
    }
  });

  test("restore() puts back the exact original function reference", () => {
    const original = (...args: unknown[]) => args;
    const fake = { error: original };
    const restore = installLogSink(fake);
    expect(fake.error).not.toBe(original);
    restore();
    expect(fake.error).toBe(original);
  });

  test("a line with no newline passes through unchanged, not merely un-mangled", () => {
    const calls: unknown[][] = [];
    const fake = { error: (...args: unknown[]) => calls.push(args) };
    const restore = installLogSink(fake);
    try {
      fake.error("[tools2] caller=BUTCHR-9 verb=jira_get_issue outcome=ok");
      expect(calls[0]![0]).toBe("[tools2] caller=BUTCHR-9 verb=jira_get_issue outcome=ok");
    } finally {
      restore();
    }
  });
});
