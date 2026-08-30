import { describe, expect, test } from "bun:test";
import { computeRelease } from "../../scripts/release/compute-release.js";
import { parseFragment, type Fragment } from "../../scripts/release/fragments.js";

const frag = (path: string, body: string): Fragment => parseFragment(path, body);

describe("computeRelease", () => {
  test("no fragments = no-op (null)", () => {
    expect(computeRelease("0.1.0", [], null, "2026-08-30")).toBeNull();
  });

  test("single fragment: version bumped by its declared level, entry collates its bullets", () => {
    const r = computeRelease("0.1.0", [frag("changelog.d/A.md", "bump: patch\n### Fixed\n- a bug\n")], null, "2026-08-30");
    expect(r).not.toBeNull();
    expect(r!.version).toBe("0.1.1");
    expect(r!.changelogEntry).toBe("## [0.1.1] - 2026-08-30\n### Fixed\n- a bug\n");
    expect(r!.consumed).toEqual(["changelog.d/A.md"]);
  });

  test("multiple fragments: HIGHEST declared level wins, single-step, all bullets collated by section", () => {
    const fragments = [
      frag("changelog.d/A.md", "bump: patch\n### Fixed\n- fix one\n"),
      frag("changelog.d/B.md", "bump: minor\n### Added\n- feature two\n"),
      frag("changelog.d/C.md", "bump: patch\n### Fixed\n- fix three\n"),
    ];
    const r = computeRelease("1.2.3", fragments, null, "2026-08-30")!;
    expect(r.version).toBe("1.3.0"); // minor wins over patch, single-step (patch reset to 0)
    expect(r.changelogEntry).toBe("## [1.3.0] - 2026-08-30\n### Added\n- feature two\n### Fixed\n- fix one\n- fix three\n");
    expect(r.consumed.sort()).toEqual(["changelog.d/A.md", "changelog.d/B.md", "changelog.d/C.md"]);
  });

  test("strictly-greater-than-registry is enforced — throws rather than silently under-bumping", () => {
    expect(() => computeRelease("0.1.0", [frag("x.md", "bump: patch\n### Fixed\n- x\n")], "0.1.1", "2026-08-30")).toThrow(/not greater than published 0\.1\.1/);
  });
  test("registry equal to the computed version also throws (strictly greater, not greater-or-equal)", () => {
    expect(() => computeRelease("0.1.0", [frag("x.md", "bump: patch\n### Fixed\n- x\n")], "0.1.1", "2026-08-30")).toThrow();
  });
  test("no registry entry (unpublished) never blocks", () => {
    expect(computeRelease("0.1.0", [frag("x.md", "bump: patch\n### Fixed\n- x\n")], null, "2026-08-30")!.version).toBe("0.1.1");
  });

  test("a fragment with no valid declared bump fails loudly instead of silently skipping it", () => {
    expect(() => computeRelease("0.1.0", [frag("x.md", "### Fixed\n- x\n")], null, "2026-08-30")).toThrow(/no fragment.*valid|none declares/i);
  });
});
