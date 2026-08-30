import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Facts } from "./gate.js";
import { parseFragment } from "./fragments.js";

const sh = (c: string) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const at = (ref: string, file: string) => { try { return sh(`git show ${ref}:${file}`); } catch { return ""; } };

/** `base` is the ref to compare against — `origin/<base-branch>` in CI, `HEAD~1` on main itself. */
export function gatherFacts(base: string): Facts {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  // baseVersion must share a reference point with changedFiles (merge-base relative, below) or a
  // branch that is merely behind base reads as a downgrade. Fall back to the base tip if merge-base
  // can't be resolved (unrelated histories, shallow clone) rather than crashing the gate.
  let mergeBase = base;
  try { mergeBase = sh(`git merge-base ${base} HEAD`); } catch { /* fall back to base tip */ }
  const basePkg = at(mergeBase, "package.json");
  const baseTipPkg = at(base, "package.json");
  const addedFragmentPaths = sh(`git diff --name-only --diff-filter=A ${base}...HEAD -- changelog.d/`)
    .split("\n").filter((p) => p && /\.md$/.test(p) && p !== "changelog.d/README.md");
  return {
    version: pkg.version,
    baseVersion: basePkg ? JSON.parse(basePkg).version : "0.0.0",
    baseTipVersion: baseTipPkg ? JSON.parse(baseTipPkg).version : undefined,
    changedFiles: sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    baseChangelog: at(base, "CHANGELOG.md"),
    schemaChanged: sh(`git diff --name-only ${base}...HEAD -- schema/herdr-api.schema.json`) !== "",
    newFragments: addedFragmentPaths.map((p) => parseFragment(p, readFileSync(p, "utf8"))),
    today: new Date().toISOString().slice(0, 10),
  };
}
