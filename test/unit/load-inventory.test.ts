import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTestPathFor, loadTestSource, loadableFiles } from "../../scripts/load/inventory.js";

const ROOT = join(import.meta.dir, "..", "..");
describe("every source file has a load test", () => {
  const files = loadableFiles(ROOT);
  test("there are source files to check", () => { expect(files.length).toBeGreaterThan(15); });
  for (const f of files) {
    test(`${f} → ${loadTestPathFor(f)}`, () => {
      const p = join(ROOT, loadTestPathFor(f));
      expect(existsSync(p), `missing — run: bun run scripts/load/generate.ts`).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(loadTestSource(f));
    });
  }
  test("no orphan load tests", () => {
    const expected = new Set(files.map(loadTestPathFor));
    const orphans = readdirSync(join(ROOT, "test/load")).filter((n) => n.endsWith(".load.test.ts")).map((n) => `test/load/${n}`).filter((p) => !expected.has(p));
    expect(orphans).toEqual([]);
  });
});
