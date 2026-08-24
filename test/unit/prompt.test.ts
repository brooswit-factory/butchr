import { describe, expect, test } from "bun:test";
import { parsePrompt, keysToSelect } from "../../src/agents/prompt.js";

// The real prompt captured from a blocked herdr agent (pane.read source:detection).
const REAL = `This session is 2d 12h old and 673.2k tokens.
Resuming the full session will consume a substantial portion of your usage limits. We
recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
Enter to confirm · Esc to cancel`;

describe("parsePrompt", () => {
  test("parses the real Claude selection prompt: question, options, current", () => {
    const p = parsePrompt(REAL)!;
    expect(p.options).toEqual(["Resume from summary (recommended)", "Resume full session as-is", "Don't ask me again"]);
    expect(p.current).toBe(1);
    expect(p.question).toContain("Resuming the full session");
    expect(p.question).not.toContain("Enter to confirm");
  });
  test("current follows the ❯ marker", () => {
    const p = parsePrompt("Pick one\n  1. a\n❯ 2. b\n  3. c")!;
    expect(p.current).toBe(2); expect(p.options).toEqual(["a", "b", "c"]);
  });
  test("returns null when there is no menu", () => {
    expect(parsePrompt("just some output, no options")).toBeNull();
    expect(parsePrompt("❯ 1. only one option")).toBeNull(); // needs >= 2
  });
});
describe("keysToSelect", () => {
  test("arrows down for a higher target, up for lower, and always confirms", () => {
    expect(keysToSelect(1, 1)).toBe("\r");
    expect(keysToSelect(1, 3)).toBe("\x1b[B\x1b[B\r");
    expect(keysToSelect(3, 1)).toBe("\x1b[A\x1b[A\r");
  });
});
