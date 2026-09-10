import { describe, expect, test } from "bun:test";
import { HTML4_NAMED_ENTITIES } from "../../src/tools/html4-named-entities.generated.js";

/**
 * Pins the vendored table (`scripts/vendor/html4-entities.ts`) against the
 * exact measured boundary BUTCHR-250's PR #299 second review round
 * established: Confluence's storage layer re-encodes a character IFF it has
 * a standard HTML4 named entity. A regeneration that silently drifted from
 * the W3C spec (wrong source, a parser bug, a truncated fetch) would fail
 * these assertions rather than passing unnoticed — this is the "pin a few
 * representative rows" arm the review asked for.
 */
describe("html4-named-entities.generated.ts — pinned against the measured Confluence-encoding boundary", () => {
  const byCodepoint = new Map(HTML4_NAMED_ENTITIES);

  test("has exactly the 252 entities HTML 4.01 defines — a wildly different count means the source/parser drifted", () => {
    expect(HTML4_NAMED_ENTITIES.length).toBe(252);
  });

  test("no duplicate codepoints and no duplicate entity names", () => {
    const codes = new Set(HTML4_NAMED_ENTITIES.map(([c]) => c));
    const names = new Set(HTML4_NAMED_ENTITIES.map(([, n]) => n));
    expect(codes.size).toBe(HTML4_NAMED_ENTITIES.length);
    expect(names.size).toBe(HTML4_NAMED_ENTITIES.length);
  });

  test("every entity name is a bare alphabetic identifier (no leading '&', no trailing ';', no stray whitespace)", () => {
    for (const [, name] of HTML4_NAMED_ENTITIES) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  // The exact 16 characters independently re-derived and confirmed against
  // this table while investigating the review's finding.
  test.each([
    [0x2014, "mdash", "—"],
    [0x2013, "ndash", "–"],
    [0x2026, "hellip", "…"],
    [0x2192, "rarr", "→"],
    [0x2190, "larr", "←"],
    [0x201c, "ldquo", "“"],
    [0x201d, "rdquo", "”"],
    [0x2018, "lsquo", "‘"],
    [0x2019, "rsquo", "’"],
    [0x0394, "Delta", "Δ"],
    [0x03a9, "Omega", "Ω"],
    [0x2202, "part", "∂"],
    [0x2135, "alefsym", "ℵ"],
    [0x2660, "spades", "♠"],
    [0x2308, "lceil", "⌈"],
    [0x2234, "there4", "∴"],
    [0x2295, "oplus", "⊕"],
  ] as const)("codepoint U+%s (%s, %s) maps to the expected entity name", (code, expectedName) => {
    expect(byCodepoint.get(code)).toBe(expectedName);
  });

  // The review's live probe (BUTCHR-250 PR #299, second round): 20 characters
  // deliberately chosen as ordinary prose/typography, all of which have a
  // standard HTML4 named entity and all of which Confluence was measured
  // re-encoding.
  test("every character the review measured being re-encoded HAS a table entry", () => {
    const measuredEncoded = "× ° é • ≥ ½ ± § © µ à ü ñ ∞ ≈ † ‰ € ™ ·".split(" ");
    for (const ch of measuredEncoded) {
      expect(byCodepoint.has(ch.codePointAt(0)!)).toBe(true);
    }
  });

  // The other half of the same probe: 10 characters with NO standard named
  // entity (CJK, emoji, IPA, other-script letters), all of which Confluence
  // was measured leaving untouched.
  test("every character the review measured surviving literal has NO table entry", () => {
    const measuredLiteral = "漢 😀 ʃ ŧ ǽ ᴀ ค ж א ᚠ".split(" ");
    for (const ch of measuredLiteral) {
      expect(byCodepoint.has(ch.codePointAt(0)!)).toBe(false);
    }
  });
});
