import { bumpVersion, compare, fmt, parse } from "./semver.js";
import { collateEntry } from "./changelog.js";
import { highestBump, type Fragment } from "./fragments.js";

export interface Release { version: string; changelogEntry: string; consumed: string[] }

/**
 * Pure merge-time computation: main's current package.json version, bumped by the HIGHEST
 * declared level among the fragments present on main, single-step, strictly greater than the
 * npm registry `latest`. Null = no fragments present = nothing to release (no-op).
 * Throws (fail loudly) on an unpublishable result — a fragment with no valid declared bump, or
 * a computed version that isn't strictly greater than what's already published.
 */
export function computeRelease(pkgVersion: string, fragments: Fragment[], registryLatest: string | null, today: string): Release | null {
  if (fragments.length === 0) return null;

  const highest = highestBump(fragments);
  if (!highest) throw new Error(`${fragments.length} fragment(s) present on main but none declares a valid "bump: major|minor|patch" — cannot compute a release`);

  const from = parse(pkgVersion);
  if (!from) throw new Error(`package.json version "${pkgVersion}" is not x.y.z`);
  const to = bumpVersion(from, highest);

  const reg = registryLatest ? parse(registryLatest) : null;
  if (reg && compare(to, reg) <= 0) throw new Error(`computed ${fmt(to)} (${pkgVersion} + ${highest}) is not greater than published ${registryLatest}`);

  return { version: fmt(to), changelogEntry: collateEntry(fmt(to), today, fragments), consumed: fragments.map((f) => f.path) };
}
