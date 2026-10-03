import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRelease, type Release } from "./compute-release.js";
import { parseFragment } from "./fragments.js";
import { fragmentsAddedSince, latestVTag } from "./git.js";

export interface TagReleaseResult {
  /** The `v*` tag this release (if any) would bump from. */
  baseTag: string;
  /** `null` when `changelog.d/` has no fragment added since `baseTag` — nothing to release. */
  release: Release | null;
}

/**
 * Ties the git facts (latest reachable `v*` tag, fragments added since it)
 * to the pure `computeRelease` — "what would the NEXT release be, as of
 * `head` in the repo at `cwd`?"
 *
 * Throws when there is no `v*` tag reachable from `head` at all — a repo
 * (or a point in its history) with no release tag has no base version to
 * bump from, and defaulting to an implicit `0.0.0` would be a GUESS, not a
 * fact read from the repo. The documented, deliberate choice (FACTORY-627):
 * refuse with a clear message rather than guess. The first release of a
 * repo using this tool must be seeded by hand — tag a starting version
 * (and, if there are pre-existing `changelog.d/` fragments that should not
 * retroactively count, that tag must be made at a commit at or after them)
 * — before this tool can compute anything.
 */
export function computeTagRelease(cwd: string, head: string): TagReleaseResult {
  const base = latestVTag(cwd, head);
  if (!base) {
    throw new Error(
      `no "v*" tag (exactly vX.Y.Z) reachable from ${head} — this repo has no release history to bump from. ` +
        `Refusing to guess a starting version (e.g. 0.0.0): seed the first release by hand (tag the chosen starting ` +
        `version at the chosen starting commit) before this tool can compute the next one.`,
    );
  }
  const fragmentPaths = fragmentsAddedSince(cwd, base.tag, head);
  const fragments = fragmentPaths.map((p) => parseFragment(p, readFileSync(join(cwd, p), "utf8")));
  return { baseTag: base.tag, release: computeRelease(base.version, fragments) };
}
