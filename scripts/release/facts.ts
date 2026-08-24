import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Facts } from "./gate.js";

const sh = (c: string) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const at = (ref: string, file: string) => { try { return sh(`git show ${ref}:${file}`); } catch { return ""; } };

/** `base` is the ref to compare against — `origin/main` in CI, `HEAD~1` on main itself. */
export function gatherFacts(base: string, pkgName: string): Facts {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const basePkg = at(base, "package.json");
  let registryLatest: string | null = null;
  try { registryLatest = sh(`npm view ${pkgName} version`) || null; } catch { /* unpublished */ }
  return {
    version: pkg.version,
    baseVersion: basePkg ? JSON.parse(basePkg).version : "0.0.0",
    registryLatest,
    changedFiles: sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    baseChangelog: at(base, "CHANGELOG.md"),
    schemaChanged: sh(`git diff --name-only ${base}...HEAD -- schema/herdr-api.schema.json`) !== "",
    today: new Date().toISOString().slice(0, 10),
  };
}
