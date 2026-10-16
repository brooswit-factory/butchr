import { execFileSync } from "node:child_process";
import { compare, parse, type Semver } from "./semver.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Exactly `vX.Y.Z` — a tag with extra trailing junk (`v1.2.3-rc1`) or a short form (`v1.2`) is not a release tag and is ignored by construction. */
const VTAG_RE = /^v(\d+\.\d+\.\d+)$/;

export interface TagRef { tag: string; version: Semver }

/**
 * Every `v*` tag that is exactly `vX.Y.Z` AND reachable from `head` (an
 * ancestor of it, including `head` itself) — every argument here is passed
 * as its own `execFileSync` argv entry, never interpolated into a shell
 * string, so a hostile-looking tag or ref name is always inert.
 *
 * A tag merged in on some other branch and never reached by `head` must
 * never be treated as part of THIS branch's release history — that is what
 * "reachable" guards against.
 */
export function reachableVTags(cwd: string, head: string): TagRef[] {
  let raw: string[];
  try {
    raw = git(cwd, ["tag", "--list", "v*"]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const out: TagRef[] = [];
  for (const tag of raw) {
    const m = VTAG_RE.exec(tag);
    if (!m) continue; // not a release tag (non-v, or v without exactly x.y.z) — ignored
    const version = parse(m[1]!);
    if (!version) continue;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", tag, head], { cwd, stdio: "ignore" });
    } catch {
      continue; // not reachable from head (or doesn't resolve) — not part of this branch's history
    }
    out.push({ tag, version });
  }
  return out;
}

/**
 * The latest `v*` tag reachable from `head`, ordered by SEMVER — never by
 * git's tag-creation order or lexical sort, so a tag made later for an
 * earlier version (a backport) never wins. `null` when no such tag is
 * reachable at all — a repo (or a point in its history) with no release
 * tag yet, which the caller must treat as "no base to bump from", never as
 * an implicit 0.0.0.
 */
export function latestVTag(cwd: string, head: string): TagRef | null {
  const tags = reachableVTags(cwd, head);
  if (tags.length === 0) return null;
  return tags.reduce((best, t) => (compare(t.version, best.version) > 0 ? t : best));
}

/**
 * Commits strictly between `tag` (exclusive) and `head` (inclusive) —
 * `git rev-list --count <tag>..<head>`. 0 when `head` IS the tagged commit.
 * Used by `src/agents/build-identity.ts` to report `X.Y.Z` (0 commits past
 * the tag) vs `X.Y.Z+N` (N commits past it) as the daemon's own version,
 * instead of the frozen `package.json` number.
 */
export function commitsSince(cwd: string, tag: string, head: string): number {
  let out: string;
  try {
    out = git(cwd, ["rev-list", "--count", `${tag}..${head}`]).trim();
  } catch (e) {
    throw new Error(`could not count commits between ${tag} and ${head}: ${(e as Error).message.split("\n")[0]}`);
  }
  const n = Number(out);
  if (!Number.isInteger(n) || n < 0) throw new Error(`unexpected "git rev-list --count ${tag}..${head}" output: ${JSON.stringify(out)}`);
  return n;
}

/**
 * `changelog.d/*.md` fragments ADDED strictly between `tag` (exclusive) and
 * `head` (inclusive) — `README.md` excluded. A fragment already present AT
 * `tag` is never returned: `--diff-filter=A` only matches a path that did
 * not exist on the `tag` side of the diff, so a fragment already collated
 * into an earlier release (or simply pre-dating the tag) never recounts,
 * even if a later commit modifies its content.
 */
export function fragmentsAddedSince(cwd: string, tag: string, head: string): string[] {
  let names: string[];
  try {
    names = git(cwd, ["diff", "--name-only", "--diff-filter=A", `${tag}..${head}`, "--", "changelog.d/"]).split("\n").filter(Boolean);
  } catch (e) {
    throw new Error(`could not diff changelog.d/ between ${tag} and ${head}: ${(e as Error).message.split("\n")[0]}`);
  }
  return names.filter((p) => p.endsWith(".md") && p !== "changelog.d/README.md").sort();
}
