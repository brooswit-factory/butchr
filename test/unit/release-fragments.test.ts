import { describe, expect, test } from "bun:test";
import { hasBreaking, highestBump, parseFragment } from "../../scripts/release/fragments.js";

describe("parseFragment", () => {
  test("reads the declared bump and the sections below it", () => {
    const f = parseFragment("changelog.d/X.md", "bump: minor\n\n### Added\n- a thing\n### Fixed\n- a bug\n");
    expect(f).toEqual({ path: "changelog.d/X.md", bump: "minor", sections: { Added: ["a thing"], Fixed: ["a bug"] }, unknownHeadings: [] });
  });
  test("an unrecognized or missing bump line reads as null, not a crash", () => {
    expect(parseFragment("x.md", "### Added\n- a\n").bump).toBeNull();
    expect(parseFragment("x.md", "bump: huge\n### Added\n- a\n").bump).toBeNull();
  });
  test("the bump line can appear anywhere; every ### section in the file still counts", () => {
    const f = parseFragment("x.md", "### Added\n- before\nbump: patch\n### Fixed\n- after\n");
    expect(f.bump).toBe("patch");
    expect(f.sections.Added).toEqual(["before"]);
    expect(f.sections.Fixed).toEqual(["after"]);
  });
});

describe("unknownHeadings (FACTORY-192: an unrecognised heading must not silently vanish)", () => {
  test("no unknown headings when every heading is a recognised section", () => {
    expect(parseFragment("x.md", "bump: patch\n### Added\n- a\n### Fixed\n- b\n").unknownHeadings).toEqual([]);
  });
  test("unknown-only: a single unrecognised heading is reported verbatim", () => {
    expect(parseFragment("x.md", "bump: patch\n### Notes\n- a\n").unknownHeadings).toEqual(["Notes"]);
  });
  test("mixed: a fragment with both a recognised and an unrecognised heading reports only the latter", () => {
    const f = parseFragment("x.md", "bump: patch\n### Fixed\n- a bug\n### Notes\n- lost otherwise\n");
    expect(f.unknownHeadings).toEqual(["Notes"]);
    expect(f.sections.Fixed).toEqual(["a bug"]); // the recognised section's bullet still parses normally
  });
  test("a multi-word heading is reported (and wouldn't even be seen as a heading by the single-word SECTIONS match)", () => {
    expect(parseFragment("x.md", "bump: patch\n### Known Issues\n- a\n").unknownHeadings).toEqual(["Known Issues"]);
  });
  test("a punctuated heading is reported", () => {
    expect(parseFragment("x.md", "bump: patch\n### Fixed!\n- a\n").unknownHeadings).toEqual(["Fixed!"]);
  });
  test("a repeated unrecognised heading is deduplicated", () => {
    expect(parseFragment("x.md", "bump: patch\n### Notes\n- a\n### Notes\n- b\n").unknownHeadings).toEqual(["Notes"]);
  });
});

describe("wrapped bullets", () => {
  test("indented lines under a bullet join it instead of being dropped", () => {
    const f = parseFragment("x.md", "bump: minor\n### Added\n- first line\n  second line\n  third line\n- next\n\n### Fixed\n- x\n");
    expect(f.sections.Added).toEqual(["first line second line third line", "next"]);
    expect(f.sections.Fixed).toEqual(["x"]);
  });
  test("a blank line or a new heading ends the continuation", () => {
    const f = parseFragment("x.md", "### Added\n- a\n\n  stray\n");
    expect(f.sections.Added).toEqual(["a stray"]);
  });
});

describe("hasBreaking", () => {
  test("true only when the BREAKING section has bullets", () => {
    expect(hasBreaking(parseFragment("x.md", "bump: major\n### BREAKING\n- oops\n"))).toBe(true);
    expect(hasBreaking(parseFragment("x.md", "bump: major\n### BREAKING\n"))).toBe(false);
    expect(hasBreaking(parseFragment("x.md", "bump: patch\n### Fixed\n- x\n"))).toBe(false);
  });
});

describe("highestBump", () => {
  test("major beats minor beats patch, across several fragments", () => {
    const f = (bump: string) => parseFragment("x.md", `bump: ${bump}\n### Added\n- x\n`);
    expect(highestBump([f("patch"), f("minor"), f("patch")])).toBe("minor");
    expect(highestBump([f("minor"), f("major"), f("patch")])).toBe("major");
  });
  test("null for no fragments, or fragments with no valid bump", () => {
    expect(highestBump([])).toBeNull();
    expect(highestBump([parseFragment("x.md", "### Added\n- x\n")])).toBeNull();
  });
});
