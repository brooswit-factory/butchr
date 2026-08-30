import { bumpVersion, compare, fmt, parse } from "./semver.js";
import { collateEntry } from "./changelog.js";
import { hasBreaking, highestBump, type Fragment } from "./fragments.js";

export interface Release { version: string; changelogEntry: string; consumed: string[] }

/**
 * Pure merge-time computation: main's current package.json version, bumped by the HIGHEST
 * declared level among the fragments present on main, single-step, strictly greater than the
 * npm registry `latest`. Null = no fragments present = nothing to release (no-op).
 *
 * `main` has no branch protection, and the PR gate only validates a fragment ADDED by a given
 * PR (git diff-filter=A) — a fragment already on main can be silently modified by a later PR
 * (or a direct push) without ever being re-validated, and still gets collated here. So this is
 * the last line of defence and re-validates EVERY fragment present, not just the ones needed to
 * find the highest bump: throws (fail loudly, nothing written, nothing published) if ANY
 * fragment lacks a valid declared bump, or if ANY fragment's BREAKING content disagrees with its
 * declared level — a mis-declared fragment must never be silently skipped while its bullets are
 * still collated into the release. Also throws if the computed result isn't strictly greater
 * than what's already published.
 */
export function computeRelease(pkgVersion: string, fragments: Fragment[], registryLatest: string | null, today: string): Release | null {
  if (fragments.length === 0) return null;

  const invalid = fragments.filter((fr) => fr.bump === null);
  if (invalid.length) throw new Error(`fragment(s) with no valid "bump: major|minor|patch" line: ${invalid.map((fr) => fr.path).join(", ")} — refusing to compute a release rather than silently skip them`);

  const mismatched = fragments.filter((fr) => hasBreaking(fr) !== (fr.bump === "major"));
  if (mismatched.length) throw new Error(`fragment(s) where ### BREAKING content and the declared bump disagree: ${mismatched.map((fr) => `${fr.path} (bump: ${fr.bump}, BREAKING: ${hasBreaking(fr)})`).join(", ")} — refusing to compute a release`);

  const highest = highestBump(fragments)!; // every fragment validated above — always non-null here
  const from = parse(pkgVersion);
  if (!from) throw new Error(`package.json version "${pkgVersion}" is not x.y.z`);
  const to = bumpVersion(from, highest);

  const reg = registryLatest ? parse(registryLatest) : null;
  if (reg && compare(to, reg) <= 0) throw new Error(`computed ${fmt(to)} (${pkgVersion} + ${highest}) is not greater than published ${registryLatest}`);

  return { version: fmt(to), changelogEntry: collateEntry(fmt(to), today, fragments), consumed: fragments.map((f) => f.path) };
}
