import { describe, expect, test } from "bun:test";
import { bumpKind, compare, parse } from "../../scripts/release/semver.js";

const v = (s: string) => parse(s)!;
describe("semver rules", () => {
  test("parses x.y.z only", () => { expect(parse("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 }); expect(parse("1.2")).toBeNull(); expect(parse("v1.2.3")).toBeNull(); });
  test("single-step bumps", () => {
    expect(bumpKind(v("0.1.0"), v("0.1.1"))).toBe("patch");
    expect(bumpKind(v("0.1.0"), v("0.2.0"))).toBe("minor");
    expect(bumpKind(v("0.9.9"), v("1.0.0"))).toBe("major");
  });
  test("rejects skips, non-resets, no-ops and backwards", () => {
    for (const [a, b] of [["0.1.0","0.3.0"],["0.1.0","0.2.1"],["0.1.0","0.1.0"],["0.2.0","0.1.0"],["0.1.0","1.1.0"]]) expect(bumpKind(v(a!), v(b!)), `${a}→${b}`).toBeNull();
  });
  test("compare", () => { expect(compare(v("0.2.0"), v("0.1.9"))).toBeGreaterThan(0); expect(compare(v("1.0.0"), v("1.0.0"))).toBe(0); });
});
