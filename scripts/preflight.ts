import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function safe(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const bunVersion = process.versions.bun ?? "not found";
const nodeSegment = safe(() => `node ${execSync("node -v", { encoding: "utf8" }).trim()}`, "node: not found");
const tscVersion = safe(() => JSON.parse(readFileSync("node_modules/typescript/package.json", "utf8")).version, "not found");

console.log(`preflight: bun ${bunVersion}, ${nodeSegment}, tsc ${tscVersion} (typecheck runs under bun)`);
