import { bumpVersion, fmt, type Semver } from "./semver.js";
import { collateNotes } from "./changelog.js";
import { hasBreaking, highestBump, type Fragment } from "./fragments.js";

export interface Release { version: string; notes: string; consumed: string[] }

/**
 * Pure (FACTORY-627, option B): `baseVersion` — the latest `v*` tag's
 * version, resolved by the caller (see `compute-tag-release.ts`) — bumped
 * by the HIGHEST declared level among `fragments` (added since that tag).
 * `fragments.length === 0` = nothing to release (null) — there is no "patch
 * bump by default"; silence from `changelog.d/` means no release at all.
 *
 * Re-validates EVERY fragment, not just the one with the winning bump: a
 * fragment on `main` can be modified by a later PR, or by a direct push
 * (main has no branch protection), without ever being re-checked by the PR
 * gate (`gate.ts` only validates fragments a PR itself ADDS) — so this is
 * the last line of defence. Throws (writes nothing, tags nothing) if ANY
 * fragment lacks a valid declared bump, or if ANY fragment's `### BREAKING`
 * content disagrees with its declared level — a mis-declared fragment must
 * never be silently dropped while its bullets are still released.
 *
 * No registry/npm check here (FACTORY-620 removed the npm publish path
 * entirely): a tag bump is by construction strictly greater than
 * `baseVersion`, so there is nothing left to compare against.
 */
export function computeRelease(baseVersion: Semver, fragments: Fragment[]): Release | null {
  if (fragments.length === 0) return null;

  const invalid = fragments.filter((fr) => fr.bump === null);
  if (invalid.length) throw new Error(`fragment(s) with no valid "bump: major|minor|patch" line: ${invalid.map((fr) => fr.path).join(", ")} — refusing to compute a release rather than silently skip them`);

  const mismatched = fragments.filter((fr) => hasBreaking(fr) !== (fr.bump === "major"));
  if (mismatched.length) throw new Error(`fragment(s) where ### BREAKING content and the declared bump disagree: ${mismatched.map((fr) => `${fr.path} (bump: ${fr.bump}, BREAKING: ${hasBreaking(fr)})`).join(", ")} — refusing to compute a release`);

  const highest = highestBump(fragments)!; // every fragment validated above — always non-null here
  const to = bumpVersion(baseVersion, highest);

  return { version: fmt(to), notes: collateNotes(fragments), consumed: fragments.map((f) => f.path) };
}
