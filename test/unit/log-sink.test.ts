import { describe, expect, test } from "bun:test";
import { flattenNewlines, installLogSink } from "../../src/daemon/log-sink.js";

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

  test("a non-string argument passes through unmodified — only a string can carry a raw newline into a parsed line", () => {
    const calls: unknown[][] = [];
    const fake = { error: (...args: unknown[]) => calls.push(args) };
    const restore = installLogSink(fake);
    try {
      const err = new Error("boom\nwith a newline in the message");
      fake.error(err);
      expect(calls[0]![0]).toBe(err);
    } finally {
      restore();
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
