import { describe, expect, test } from "bun:test";
import { hasContent, parseChangelog } from "../../scripts/release/changelog.js";

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
