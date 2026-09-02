import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSystemdInfo, type SystemdInfo } from "./ground-truth.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * BUTCHR-54: which build a running daemon actually is, captured ONCE at
 * process start and frozen for the process's lifetime (see `buildIdentity`
 * below) — never read from a working tree per request, which is the exact
 * mistake (reading `/proc/<pid>/cwd`'s checkout HEAD live) this ticket
 * exists to prevent.
 *
 * How the sha gets in is the real design decision, and it differs by launch
 * path (both must give a truthful answer):
 *   - `bun run src/daemon/index.ts` (package.json's "start"): runs from
 *     source, no build step. Nothing can be baked in, so this reads git
 *     ONCE, at start (`realGitAtStart`), from THIS SOURCE FILE'S OWN
 *     resolved location — never `process.cwd()`, which a systemd unit's
 *     `WorkingDirectory=` can point anywhere.
 *   - `bun run build` (package.json's "build", see scripts/build/build.ts):
 *     a real build step, and the published npm package ships only `dist/` —
 *     no `.git` anywhere near an installed daemon. The build script bakes
 *     the sha (and a dirty-tree flag) into the bundle via `Bun.build`'s
 *     `define`, so `process.env.BUTCHR_BUILD_SHA` is a compile-time string
 *     LITERAL in `dist/butchr.js` — reading it at runtime can never see a
 *     different value, regardless of the actual process environment.
 *
 * "unknown" is a correct answer here, never a guess: a baked-empty sha (git
 * unavailable at build time) falls through to the from-source git read,
 * which also fails on an npm install with no `.git` — `resolveSha` ends
 * that chain at `sha: null` with a stated reason, never a plausible default.
 */
export type ShaProvenance = "baked" | "git-at-start";

export interface ShaResult {
  sha: string | null;
  provenance: ShaProvenance | null;
  /** Whether the working tree had uncommitted changes when `sha` was captured. `null` when that itself could not be determined (or `sha` is null). */
  dirty: boolean | null;
  /** Set iff `sha` is null — WHY it could not be determined. Never silently blank. */
  unknownReason: string | null;
}

/** One `git`-at-start read attempt's result, or why it failed. Kept as data so `resolveSha` can stay pure over an injected function instead of spawning `git` itself. */
export type GitAtStart = { sha: string; dirty: boolean | null } | { error: string };

/**
 * PURE given `bakedSha`/`bakedDirty` and an injected `gitAtStart`. Takes the
 * two baked values as separate parameters — NOT a generic `env` object —
 * because the caller must pass the literal expressions
 * `process.env.BUTCHR_BUILD_SHA`/`process.env.BUTCHR_BUILD_DIRTY` verbatim
 * (see `computeBuildIdentity` below): `Bun.build`'s `define`
 * (scripts/build/build.ts) matches an exact member-expression text, so
 * reading through an intermediate `const env = process.env` variable — a
 * plain property access on `env`, not that literal expression — would
 * silently never match, and the baked value would never be seen. A baked
 * value always wins when present — it is the stronger claim, frozen before
 * the process even started and immune to a `git pull` in some nearby
 * checkout — so `gitAtStart` is only even evaluated when nothing was baked
 * (a bundled daemon always has `BUTCHR_BUILD_SHA` baked to something, even
 * `""`, so it never pays for a git spawn it doesn't need).
 */
export function resolveSha(bakedSha: string | undefined, bakedDirty: string | undefined, gitAtStart: () => GitAtStart): ShaResult {
  const baked = bakedSha?.trim();
  if (baked) {
    return { sha: baked, provenance: "baked", dirty: bakedDirty === "1", unknownReason: null };
  }
  const g = gitAtStart();
  if ("error" in g) return { sha: null, provenance: null, dirty: null, unknownReason: g.error };
  return { sha: g.sha, provenance: "git-at-start", dirty: g.dirty, unknownReason: null };
}

/**
 * The real (impure) git-at-start reader. `dir` must be this SOURCE FILE'S
 * OWN resolved location (`MODULE_DIR` below) — never `process.cwd()`. `git
 * rev-parse` searches upward for `.git` on its own, so this is correct
 * whether `dir` is `src/agents` (from-source launch, inside the real
 * checkout) or a bundled `dist/` that happens to still be inside one (a dev
 * build) — and correctly fails, never guesses, when `dist/` is an
 * npm-installed package with no `.git` anywhere above it.
 */
export function realGitAtStart(dir: string): GitAtStart {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    return { error: `no readable git repository above ${dir} (from-source launch has no baked sha, and git could not resolve one here): ${(e as Error).message.split("\n")[0]}` };
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return { error: `git rev-parse HEAD at ${dir} returned something other than a 40-char sha: ${JSON.stringify(sha)}` };
  }
  let dirty: boolean | null;
  try {
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    // The sha is still trustworthy even if this independent check fails — but
    // report the dirty flag itself as unknown rather than silently claiming clean.
    dirty = null;
  }
  return { sha, dirty };
}

/** Everything a running daemon knows about its own build, captured once (see `buildIdentity`). */
export interface BuildIdentity {
  sha: string | null;
  shaProvenance: ShaProvenance | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  /** From `package.json` at THIS SOURCE FILE'S own resolved location — a real ES import, resolved (and for the bundled path, inlined) relative to the file itself, never `process.cwd()`. */
  version: string;
  /** ISO timestamp, captured once at this module's first import (very early in daemon startup) — uptime is derived from this, never tracked separately. */
  startedAt: string;
  pid: number;
  systemd: SystemdInfo;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function computeBuildIdentity(): BuildIdentity {
  // Literal `process.env.BUTCHR_BUILD_*` member expressions, on purpose — see resolveSha's doc comment.
  const sha = resolveSha(process.env.BUTCHR_BUILD_SHA, process.env.BUTCHR_BUILD_DIRTY, () => realGitAtStart(MODULE_DIR));
  return {
    sha: sha.sha,
    shaProvenance: sha.provenance,
    shaDirty: sha.dirty,
    shaUnknownReason: sha.unknownReason,
    version: typeof pkg.version === "string" ? pkg.version : "unknown",
    startedAt: new Date().toISOString(),
    pid: process.pid,
    systemd: currentSystemdInfo(),
  };
}

/**
 * Captured exactly ONCE: module singletons are cached by the runtime, so
 * every importer of this file — however many times it's imported — shares
 * this same evaluation. Frozen for the process's lifetime: nothing that
 * happens to a nearby checkout, or to `process.env`, after this line runs
 * can ever change what a running daemon reports about itself.
 */
export const buildIdentity: BuildIdentity = computeBuildIdentity();

/** The wire shape served on `/health` (see src/daemon/health.ts) — flattens `systemd` into the unit + journalctl command an operator/the audit command actually wants, reusing `parseCgroup`'s own derivation rather than a second one. */
export interface BuildReport {
  sha: string | null;
  shaProvenance: ShaProvenance | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  version: string;
  startedAt: string;
  pid: number;
  unit: string;
  journalctl: string;
}

export function toBuildReport(b: BuildIdentity): BuildReport {
  return {
    sha: b.sha,
    shaProvenance: b.shaProvenance,
    shaDirty: b.shaDirty,
    shaUnknownReason: b.shaUnknownReason,
    version: b.version,
    startedAt: b.startedAt,
    pid: b.pid,
    unit: b.systemd.kind === "none" ? "(none)" : b.systemd.unit,
    journalctl: b.systemd.kind === "none" ? "" : b.systemd.journalctl,
  };
}
