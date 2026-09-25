/**
 * FACTORY-7: the `filesystem` ResourceRef kind's identity — an absolute,
 * normalized Unix-style path. Deliberately uses `node:path`'s `posix`
 * variant, not the platform-dependent default export, so parsing behaves
 * identically regardless of which OS runs this code or its tests: butchr's
 * own daemon runs on Linux hosts only (see this repo's systemd/journalctl
 * conventions elsewhere), and a Windows-style path (`C:\...`, a UNC path) is
 * simply not a valid `filesystem` ref in this version — reject it rather
 * than guess at a meaning.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, named so a future reader doesn't
 * "fix" them by accident:
 * - NO symlink resolution (`fs.realpathSync`). Two paths that resolve to the
 *   same file through a symlink are NOT deduped — resolving would require a
 *   live filesystem read, behaving differently depending on whether the path
 *   exists yet, which a pure identity parser must not do.
 * - NO case-folding. Unlike GitHub's owner/repo, a Unix path is
 *   case-SENSITIVE by default, so `/srv/Foo` and `/srv/foo` are different
 *   files and must not collapse to one canonical key.
 */
import { posix } from "node:path";

export interface FilesystemRef {
  path: string;
}

/** True only for an already-normalized absolute path (the form `formatFilesystemRef` produces): no `.`/`..` segments, no duplicate slashes, no trailing slash unless the path is the root `/`. */
export function isFilesystemRef(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.length > 1 && path.endsWith("/")) return false;
  return posix.normalize(path) === path;
}

export function formatFilesystemRef(ref: FilesystemRef): string {
  if (!isFilesystemRef(ref.path)) throw new Error(`invalid filesystem reference: ${JSON.stringify(ref.path)}`);
  return ref.path;
}

/**
 * `null` for a relative path or anything that fails to normalize into a
 * well-formed absolute path (never throws). Normalizes `.`/`..` segments and
 * duplicate slashes and strips a trailing slash (except the root `/`) —
 * `/a/./b/../c/` and `/a/c` parse to the same ref.
 */
export function parseFilesystemRef(input: string): FilesystemRef | null {
  if (!input.startsWith("/")) return null;
  const normalized = posix.normalize(input);
  const path = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return isFilesystemRef(path) ? { path } : null;
}
