import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { computeRelease } from "./compute-release.js";
import { prependEntry } from "./changelog.js";
import { parseFragment } from "./fragments.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const fragmentPaths = readdirSync("changelog.d")
  .filter((n) => n.endsWith(".md") && n !== "README.md")
  .map((n) => `changelog.d/${n}`)
  .sort();
const fragments = fragmentPaths.map((p) => parseFragment(p, readFileSync(p, "utf8")));

let registryLatest: string | null = null;
try { registryLatest = execSync(`npm view ${pkg.name} version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* unpublished */ }

const today = new Date().toISOString().slice(0, 10);
const out = process.env.GITHUB_OUTPUT;

let release;
try {
  release = computeRelease(pkg.version, fragments, registryLatest, today);
} catch (e) {
  console.error(`collate FAILED: ${(e as Error).message}`);
  process.exit(1);
}

if (!release) {
  console.log("collate: no changelog.d/ fragments on main — nothing to release");
  if (out) appendFileSync(out, "needed=false\n");
  process.exit(0);
}

pkg.version = release.version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
writeFileSync("CHANGELOG.md", prependEntry(readFileSync("CHANGELOG.md", "utf8"), release.changelogEntry));
for (const p of release.consumed) unlinkSync(p);

console.log(`collate: v${release.version} from ${release.consumed.length} fragment(s): ${release.consumed.join(", ")}`);
if (out) appendFileSync(out, `needed=true\nversion=${release.version}\n`);
