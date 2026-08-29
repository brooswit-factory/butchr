import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function safe(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function preflightLine(): string {
  const bunVersion = process.versions.bun ?? "not found";
  const nodeSegment = safe(() => `node ${execSync("node -v", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}`, "node: not found");
  const tscVersion = safe(() => JSON.parse(readFileSync("node_modules/typescript/package.json", "utf8")).version, "not found");
  return `preflight: bun ${bunVersion}, ${nodeSegment}, tsc ${tscVersion} (typecheck runs under bun)`;
}

// Only when run as a script — importing it (the generated load test does) must stay side-effect-free.
if (import.meta.main) console.log(preflightLine());
