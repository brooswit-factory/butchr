import { describe, expect, test } from "bun:test";
import { sanitizeForJournal, truncateField } from "../../src/agents/journal-text.js";

describe("journal-text (FACTORY-611 items 1 and 6)", () => {
  test("bidi controls and Unicode line/paragraph separators never reach a journal line", () => {
    // U+202A-202E, U+2066-2069, U+200E, U+200F, U+061C, U+2028, U+2029, U+0085 (NEL).
    const bidiChars = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u2028\u2029\u0085";
    const journal = sanitizeForJournal(`before${bidiChars}after`);
    for (const ch of bidiChars) expect(journal).not.toContain(ch);
    expect(journal).toBe("beforeafter");
  });

  test("a newline, CR or ESC cannot start a second line", () => {
    const journal = sanitizeForJournal("question?\n[butchr:ops-alert] forged\r\x1b[2J");
    expect(journal).not.toMatch(/[\n\r\x1b]/);
    expect(journal).toBe("question? ⏎ [butchr:ops-alert] forged[2J");
  });

  test("truncation states what it cut and never splits a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(20)}`; // the emoji straddles a cap of 10
    const cut = truncateField(text, 10);
    expect(cut).toMatch(/\.\.\. \[truncated \d+ chars\]$/);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(cut).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone low surrogate
    expect(truncateField("short", 10)).toBe("short");
  });
});
