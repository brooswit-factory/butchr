/**
 * BUTCHR-54: the real build step. Bakes the git sha (and a dirty-tree flag)
 * this build was made FROM into `dist/butchr.js` via `Bun.build`'s `define`
 * — `process.env.BUTCHR_BUILD_SHA`/`BUTCHR_BUILD_DIRTY` become string
 * LITERALS in the bundled output, so `src/agents/build-identity.ts`'s
 * `resolveSha` sees the same value at runtime no matter what the process's
 * actual environment says or what happens to a nearby checkout afterward.
 * The published npm package ships only `dist/` (`package.json`'s `files`) —
 * no `.git` anywhere near an installed daemon — so this is the ONLY point
 * where that launch path can ever learn its own sha.
 *
 * `git` failing here (not installed, not a checkout, a shallow clone with a
 * detached HEAD it still can't resolve — none observed, but not assumed
 * impossible) is not a build failure: it bakes an EMPTY string, which
 * `resolveSha` treats exactly like "nothing baked" and falls through to its
 * own from-source git-at-start attempt (which will also find no `.git` in a
 * bundled `dist/`) — ending in an honest "unknown", never a guess, and never
 * a build that refuses to ship over a missing sha.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function gitOrEmpty(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const sha = gitOrEmpty(["rev-parse", "HEAD"]);
const dirty = sha ? (gitOrEmpty(["status", "--porcelain"]).length > 0 ? "1" : "0") : "";

const OUTDIR = "dist";
const OUTFILE = `${OUTDIR}/butchr.js`;

const result = await Bun.build({
  entrypoints: ["src/daemon/index.ts"],
  outdir: OUTDIR,
  naming: "butchr.js",
  target: "bun",
  define: {
    "process.env.BUTCHR_BUILD_SHA": JSON.stringify(sha),
    "process.env.BUTCHR_BUILD_DIRTY": JSON.stringify(dirty),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// `bin` needs a shebang; `Bun.build` never adds one.
writeFileSync(OUTFILE, `#!/usr/bin/env bun\n${readFileSync(OUTFILE, "utf8")}`);
chmodSync(OUTFILE, 0o755);

console.log(`built ${OUTFILE} (sha=${sha || "unknown"}${dirty === "1" ? ", dirty working tree" : ""})`);
