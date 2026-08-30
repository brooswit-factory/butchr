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
    expect(() => computeRelease("0.1.0", [frag("x.md", "### Fixed\n- x\n")], null, "2026-08-30")).toThrow(/no valid "bump/);
  });

  test("the DANGEROUS case: one valid fragment alongside one with an unparseable bump line still throws — it must not silently drop the bad one while collating its bullets", () => {
    // BUMP_RE is case-sensitive: "Major" (capitalized) never matches — this is exactly the shape
    // a modified-not-added fragment could carry, since the PR gate only validates ADDED fragments.
    const fragments = [
      frag("changelog.d/A.md", "bump: patch\n### Fixed\n- a small fix\n"),
      frag("changelog.d/B.md", "bump: Major\n### BREAKING\n- the daemon API is restructured\n"),
    ];
    expect(() => computeRelease("0.1.0", fragments, null, "2026-08-30")).toThrow(/B\.md/);
  });

  test("BREAKING content that disagrees with its declared bump throws at merge time too, not just at the gate", () => {
    // A fragment could reach main with this mismatch via a PR that only MODIFIED an
    // already-present fragment (never validated — the gate only checks ADDED fragments) or,
    // since main has no branch protection, a direct push.
    const breakingButMinor = [frag("x.md", "bump: minor\n### BREAKING\n- surprise breakage\n")];
    expect(() => computeRelease("0.1.0", breakingButMinor, null, "2026-08-30")).toThrow(/BREAKING.*disagree|x\.md/);

    const majorButNoBreaking = [frag("x.md", "bump: major\n### Added\n- just a feature\n")];
    expect(() => computeRelease("0.1.0", majorButNoBreaking, null, "2026-08-30")).toThrow(/BREAKING.*disagree|x\.md/);
  });

  test("a valid, correctly-declared BREAKING fragment alongside other valid fragments still computes normally", () => {
    const fragments = [
      frag("changelog.d/A.md", "bump: patch\n### Fixed\n- a fix\n"),
      frag("changelog.d/B.md", "bump: major\n### BREAKING\n- the real deal\n"),
    ];
    const r = computeRelease("0.1.0", fragments, null, "2026-08-30")!;
    expect(r.version).toBe("1.0.0");
    expect(r.changelogEntry).toContain("### BREAKING\n- the real deal");
  });
});
