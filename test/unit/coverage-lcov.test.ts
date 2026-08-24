import { describe, expect, test } from "bun:test";
import { pct, totalsOf } from "../../scripts/coverage/lcov.js";
describe("lcov totals", () => {
  test("sums LF/LH/FNF/FNH across records", () => {
    const t = totalsOf("SF:a\nFNF:2\nFNH:1\nLF:10\nLH:9\nend_of_record\nSF:b\nFNF:2\nFNH:2\nLF:10\nLH:10\nend_of_record\n");
    expect(t).toEqual({ lines: { hit: 19, found: 20 }, functions: { hit: 3, found: 4 } });
    expect(pct(t.lines)).toBe(95); expect(pct({ hit: 0, found: 0 })).toBe(100);
  });
});
