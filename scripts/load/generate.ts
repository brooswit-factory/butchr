import { mkdirSync, readdirSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadTestPathFor, loadTestSource, loadableFiles } from "./inventory.js";
const ROOT = join(import.meta.dir, "..", "..");
mkdirSync(join(ROOT, "test/load"), { recursive: true });
const want = new Map(loadableFiles(ROOT).map((f) => [loadTestPathFor(f), loadTestSource(f)]));
for (const [p, src] of want) writeFileSync(join(ROOT, p), src);
// remove load tests whose source file is gone
for (const name of readdirSync(join(ROOT, "test/load"))) {
  const p = `test/load/${name}`;
  if (name.endsWith(".load.test.ts") && !want.has(p)) unlinkSync(join(ROOT, p));
}
console.log(`load tests: ${want.size} (one per source file)`);
