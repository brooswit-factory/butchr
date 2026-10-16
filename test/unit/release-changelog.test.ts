import { describe, expect, test } from "bun:test";
import { collateEntry, hasContent, headingsIn, parseChangelog, prependEntry } from "../../scripts/release/changelog.js";

const md = `# Changelog
## [0.2.0] - 2026-08-25
### Added
- a thing
### BREAKING
- nope
## [0.1.0] - 2026-08-24
### Fixed
- first
## [0.0.1] - 2026-08-20
### Notes
- unknown section is ignored
`;
describe("changelog parser", () => {
  test("entries newest first with sections", () => {
    const e = parseChangelog(md);
    expect(e.map((x) => x.version)).toEqual(["0.2.0", "0.1.0", "0.0.1"]);
    expect(e[0]!.sections.Added).toEqual(["a thing"]); expect(e[0]!.sections.BREAKING).toEqual(["nope"]);
    expect(e[1]!.date).toBe("2026-08-24");
  });
  test("bullets under an unknown section do not count as content", () => { expect(hasContent(parseChangelog(md)[2]!)).toBe(false); });
  test("a malformed heading is not an entry", () => { expect(parseChangelog("## 0.3.0\n- x\n## [0.3.0]\n- y")).toEqual([]); });
});

describe("headingsIn (FACTORY-192: must see every heading, not just single-word ones parseSections recognises)", () => {
  test("every ### heading line, verbatim, in order", () => {
    expect(headingsIn("### Added\n- a\n### Notes\n- b\n")).toEqual(["Added", "Notes"]);
  });
  test("a multi-word heading is captured whole, not truncated at the first space", () => {
    expect(headingsIn("### Known Issues\n- a\n")).toEqual(["Known Issues"]);
  });
  test("a punctuated heading is captured verbatim", () => {
    expect(headingsIn("### Fixed!\n- a\n")).toEqual(["Fixed!"]);
  });
  test("no headings in a fragment with none", () => { expect(headingsIn("bump: patch\n- not a heading\n")).toEqual([]); });
});

describe("collateEntry", () => {
  test("collates bullets from several sources, in SECTIONS order, sources concatenated in order", () => {
    const sources = [
      { sections: { Added: ["a1"], Fixed: ["f1"] } },
      { sections: { BREAKING: ["b1"], Added: ["a2"] } },
    ];
    const block = collateEntry("1.0.0", "2026-08-30", sources);
    expect(block).toBe("## [1.0.0] - 2026-08-30\n### BREAKING\n- b1\n### Added\n- a1\n- a2\n### Fixed\n- f1\n");
  });
  test("a section with no bullets across any source is omitted", () => {
    expect(collateEntry("1.0.0", "2026-08-30", [{ sections: { Added: ["a"] } }])).not.toContain("### Fixed");
  });
});

describe("prependEntry", () => {
  test("inserts just above the first existing heading, preserving the header above it", () => {
    const md = "# Changelog\n\nsome header prose\n\n## [1.0.0] - 2026-08-29\n### Added\n- old\n";
    const out = prependEntry(md, "## [1.1.0] - 2026-08-30\n### Added\n- new\n");
    expect(out).toBe("# Changelog\n\nsome header prose\n\n## [1.1.0] - 2026-08-30\n### Added\n- new\n\n## [1.0.0] - 2026-08-29\n### Added\n- old\n");
  });
  test("appends at the end when there is no existing heading yet", () => {
    const out = prependEntry("# Changelog\n\nheader only\n", "## [0.1.0] - 2026-08-30\n### Added\n- first\n");
    expect(out).toBe("# Changelog\n\nheader only\n\n## [0.1.0] - 2026-08-30\n### Added\n- first\n");
  });
});
