import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Facts } from "./gate.js";
import { parseFragment } from "./fragments.js";

const sh = (c: string) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const at = (ref: string, file: string) => { try { return sh(`git show ${ref}:${file}`); } catch { return ""; } };

const ROUTE_GREP = "\\.(get|post|put|delete|patch)\\(\\s*[\"'`]/[^\"'`]*[\"'`]";
const ROUTE_RE = /\.(?:get|post|put|delete|patch)\(\s*["'`](\/[^"'`]*)["'`]/;

/** Every HTTP route path and BUTCHR_* env name mentioned under src/ at `ref`, as `route /x` / `env BUTCHR_X`. */
export function surfaceAt(ref: string): Set<string> {
  const out = new Set<string>();
  // execFileSync, not a shell line: the route pattern contains quote characters.
  const grep = (pattern: string) => {
    try { return execFileSync("git", ["grep", "-ohE", pattern, ref, "--", "src/"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { return []; }
  };
  for (const line of grep(ROUTE_GREP)) { const m = ROUTE_RE.exec(line); if (m) out.add(`route ${m[1]}`); }
  for (const name of grep("BUTCHR_[A-Z0-9_]+")) out.add(`env ${name}`);
  return out;
}

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
  const was = surfaceAt(mergeBase), now = surfaceAt("HEAD");
  return {
    version: pkg.version,
    baseVersion: basePkg ? JSON.parse(basePkg).version : "0.0.0",
    baseTipVersion: baseTipPkg ? JSON.parse(baseTipPkg).version : undefined,
    changedFiles: sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    baseChangelog: at(base, "CHANGELOG.md"),
    schemaChanged: sh(`git diff --name-only ${base}...HEAD -- schema/herdr-api.schema.json`) !== "",
    newFragments: addedFragmentPaths.map((p) => parseFragment(p, readFileSync(p, "utf8"))),
    surface: { added: [...now].filter((x) => !was.has(x)).sort(), removed: [...was].filter((x) => !now.has(x)).sort() },
    today: new Date().toISOString().slice(0, 10),
  };
}
