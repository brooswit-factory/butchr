import { describe, expect, test } from "bun:test";
import { hasBreaking, highestBump, parseFragment } from "../../scripts/release/fragments.js";

describe("parseFragment", () => {
  test("reads the declared bump and the sections below it", () => {
    const f = parseFragment("changelog.d/X.md", "bump: minor\n\n### Added\n- a thing\n### Fixed\n- a bug\n");
    expect(f).toEqual({ path: "changelog.d/X.md", bump: "minor", sections: { Added: ["a thing"], Fixed: ["a bug"] } });
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
