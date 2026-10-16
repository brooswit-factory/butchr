import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSystemdInfo, type SystemdInfo } from "./ground-truth.js";
import { commitsSince, latestVTag } from "../../scripts/release/git.js";
import { fmt } from "../../scripts/release/semver.js";
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

/**
 * FACTORY-627: where a running daemon's REPORTED version comes from.
 * `package.json`'s own `version` field is frozen forever under the
 * tag-based release design this replaces (FACTORY-627's `release.yml`
 * never writes it) — reading it directly, as this module used to, means
 * `/health` and the dashboard report a number that stops moving the moment
 * the first tag-based release ships. "tag" is the live answer: the latest
 * reachable `v*` tag, plus how many commits past it this build is.
 * "package-json" is the fallback for when that can't be determined at all
 * (no git, no tag, a shallow clone) — never a silent reuse of the stale
 * number as if it were current; `unknownReason` on the `VersionResult`
 * always says why.
 */
export type VersionProvenance = "tag" | "package-json";

export interface VersionResult {
  version: string;
  provenance: VersionProvenance;
  /** Set iff `provenance` is "package-json" — WHY no tag-derived version was used. Never silently blank. */
  unknownReason: string | null;
}

/** One git-at-start version-resolution attempt's result, or why it failed. Kept as data so `resolveVersion` can stay pure over an injected function, same shape discipline as `GitAtStart`/`resolveSha` above. */
export type GitVersionAtStart = { tag: string; version: string; distance: number } | { error: string };

/**
 * PURE given `pkgVersion` and an injected `gitVersionAtStart`. Unlike `sha`,
 * there is no "baked at build time" path for version: FACTORY-627's release
 * tags are created AFTER a build normally exists, so a value baked into
 * `dist/` at build time would itself go stale the moment a later tag lands —
 * the git-at-start read (done once, frozen for the process's lifetime, same
 * as `sha`) is the only source that can ever be current, and "no tag
 * reachable" (or "no git at all", e.g. an npm-installed `dist/` with no
 * `.git` nearby) is handled by this same function's fallback, not a second
 * baked value.
 */
export function resolveVersion(pkgVersion: string, gitVersionAtStart: () => GitVersionAtStart): VersionResult {
  const g = gitVersionAtStart();
  if ("error" in g) return { version: pkgVersion, provenance: "package-json", unknownReason: g.error };
  const version = g.distance === 0 ? g.version : `${g.version}+${g.distance}`;
  return { version, provenance: "tag", unknownReason: null };
}

/**
 * The real (impure) git-at-start version reader — `dir` must be this SOURCE
 * FILE'S OWN resolved location (`MODULE_DIR`), same rule `realGitAtStart`
 * follows and for the same reason: never `process.cwd()`, which a systemd
 * unit's `WorkingDirectory=` can point anywhere.
 */
export function realGitVersionAtStart(dir: string): GitVersionAtStart {
  let tag: ReturnType<typeof latestVTag>;
  try {
    tag = latestVTag(dir, "HEAD");
  } catch (e) {
    return { error: `could not resolve a "v*" tag above ${dir}: ${(e as Error).message.split("\n")[0]}` };
  }
  if (!tag) return { error: `no "v*" tag (exactly vX.Y.Z) reachable from HEAD above ${dir}` };
  let distance: number;
  try {
    distance = commitsSince(dir, tag.tag, "HEAD");
  } catch (e) {
    return { error: `could not count commits since ${tag.tag} above ${dir}: ${(e as Error).message.split("\n")[0]}` };
  }
  return { tag: tag.tag, version: fmt(tag.version), distance };
}

/** Everything a running daemon knows about its own build, captured once (see `buildIdentity`). */
export interface BuildIdentity {
  sha: string | null;
  shaProvenance: ShaProvenance | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  /** The latest reachable `v*` git tag plus commits past it (`X.Y.Z` or `X.Y.Z+N`), falling back to `package.json`'s frozen number — see `VersionResult`'s own doc comment for why. */
  version: string;
  versionProvenance: VersionProvenance;
  versionUnknownReason: string | null;
  /** ISO timestamp, captured once at this module's first import (very early in daemon startup) — uptime is derived from this, never tracked separately. */
  startedAt: string;
  pid: number;
  systemd: SystemdInfo;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function computeBuildIdentity(): BuildIdentity {
  // Literal `process.env.BUTCHR_BUILD_*` member expressions, on purpose — see resolveSha's doc comment.
  const sha = resolveSha(process.env.BUTCHR_BUILD_SHA, process.env.BUTCHR_BUILD_DIRTY, () => realGitAtStart(MODULE_DIR));
  const pkgVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  const ver = resolveVersion(pkgVersion, () => realGitVersionAtStart(MODULE_DIR));
  return {
    sha: sha.sha,
    shaProvenance: sha.provenance,
    shaDirty: sha.dirty,
    shaUnknownReason: sha.unknownReason,
    version: ver.version,
    versionProvenance: ver.provenance,
    versionUnknownReason: ver.unknownReason,
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
  versionProvenance: VersionProvenance;
  versionUnknownReason: string | null;
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
    versionProvenance: b.versionProvenance,
    versionUnknownReason: b.versionUnknownReason,
    startedAt: b.startedAt,
    pid: b.pid,
    unit: b.systemd.kind === "none" ? "(none)" : b.systemd.unit,
    journalctl: b.systemd.kind === "none" ? "" : b.systemd.journalctl,
  };
}

/**
 * BUTCHR-320 (C): a one-line, human-readable rendering of a `BuildReport` —
 * for the daemon's OWN startup banner (src/daemon/index.ts), so a journal
 * window can be attributed to a build as well as to a pid (journald's pid
 * only bounds a window to one daemon GENERATION; nothing before this ticket
 * said which BUILD produced it). Takes the already-flattened `BuildReport`,
 * never `BuildIdentity` directly and never re-derives anything — the exact
 * same report `/health`'s `build` field serves (see `combineHealth`,
 * src/daemon/health.ts), reused rather than recomputed, per the ticket's own
 * "reuse; do not recompute" instruction.
 */
export function describeBuild(b: BuildReport): string {
  const sha = b.sha
    ? `${b.sha.slice(0, 8)} (${b.shaProvenance}${b.shaDirty === true ? ", dirty" : b.shaDirty === false ? ", clean" : ""})`
    : `unknown (${b.shaUnknownReason ?? "no reason recorded"})`;
  const version = b.versionProvenance === "tag" ? b.version : `${b.version} (package.json fallback: ${b.versionUnknownReason ?? "no reason recorded"})`;
  return `build ${sha} version=${version} pid=${b.pid} unit=${b.unit}`;
}
