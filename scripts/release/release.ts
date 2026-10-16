import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { computeTagRelease } from "./compute-tag-release.js";

/**
 * FACTORY-627 (option B — no bot commit): on push to `main`, tag the latest
 * `v*`-reachable version bumped by the highest `changelog.d/` fragment bump
 * added since that tag, and create a GitHub Release from the fragments'
 * notes. No commit, no push to `main`, no npm, no `package.json` or
 * `CHANGELOG.md` edit — see `.github/workflows/release.yml`'s header for why
 * (this workflow stays DISABLED until the director re-enables it).
 *
 * `--dry-run`: print what WOULD happen; create/push/tag nothing. Used both
 * by a human locally and by `ci.yml`'s informational (non-required)
 * `release-gate` dry-run step, run against every PR's own diff.
 *
 * Run locally against the real repo (no network writes in --dry-run):
 *   git fetch origin main && git checkout origin/main
 *   bun run scripts/release/release.ts --dry-run
 */
// Always the checkout's actual HEAD, never GITHUB_SHA: `release.yml`'s
// `cancel-in-progress: false` serializes this workflow with itself, but
// `actions/checkout` still pins `github.sha` to whatever triggered THIS run,
// which can already be behind `origin/main`'s real tip by the time the job
// executes (runner queueing, or another merge landing during it) — the
// workflow's own "sync onto the current origin/main" step resets the
// checkout (not `GITHUB_SHA`) to the real tip, so HEAD is the fact and
// `GITHUB_SHA` would be the stale guess.
const dryRun = process.argv.includes("--dry-run");
const cwd = process.cwd();
const head = "HEAD";
const out = process.env.GITHUB_OUTPUT;

let result;
try {
  result = computeTagRelease(cwd, head);
} catch (e) {
  console.error(`release FAILED: ${(e as Error).message}`);
  process.exit(1);
}

if (!result.release) {
  console.log(`release: no changelog.d/ fragment added since ${result.baseTag} — nothing to release`);
  if (out) appendFileSync(out, "needed=false\n");
  process.exit(0);
}

const { version, notes, consumed } = result.release;
console.log(`release: v${version} (base ${result.baseTag}) from ${consumed.length} fragment(s): ${consumed.join(", ")}`);
console.log(`\n--- notes ---\n${notes}`);

if (dryRun) {
  console.log(`(dry-run: nothing tagged, nothing released)`);
  process.exit(0);
}

if (out) appendFileSync(out, `needed=true\nversion=${version}\n`);

// Idempotent: a retrigger for a commit that already got this exact tag (e.g. a
// re-run of a completed workflow run) skips rather than fails or re-tags.
let tagExists = true;
try {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}`], { cwd, stdio: "ignore" });
} catch {
  tagExists = false;
}
if (tagExists) {
  console.log(`release: tag v${version} already exists — skipping (idempotent)`);
  process.exit(0);
}

writeFileSync("release-notes.md", notes);
execFileSync("git", ["tag", "-a", `v${version}`, head, "-m", `v${version}`], { cwd });
execFileSync("git", ["push", "origin", `v${version}`], { cwd });
execFileSync("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", "release-notes.md"], { cwd, stdio: "inherit" });
console.log(`release: created v${version}`);
