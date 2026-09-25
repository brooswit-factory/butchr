/**
 * The `filesystem` resource provider's disk side: a capped, symlink-safe walk
 * of one query's root, matching src/resources/filesystem-query.ts's
 * structured predicate against the tree beneath it.
 *
 * READ-ONLY by construction: the only I/O here is `readdir`/`lstat`/`realpath`
 * — nothing ever opens a file for writing, renames, or deletes anything.
 *
 * SAFETY
 * - Symlinks are never followed, for traversal OR as a candidate resource in
 *   their own right. This is the one rule that makes "refuse resources
 *   outside the declared root" true BY CONSTRUCTION rather than by checking
 *   each candidate's ancestry after the fact: every path this module ever
 *   reports is built by joining already-real path segments read from `root`
 *   downward, so it can never point outside `root`'s own real tree.
 * - `root` itself is resolved through `realpath` once, up front, so a `root`
 *   that is itself a symlink still walks its real target, and two rules
 *   naming the same real directory through different spellings watch the
 *   same resources, keyed by the same ids.
 * - `root` itself is NEVER a candidate resource — only its descendants.
 * - Two caps bound one poll's cost independent of match count: `MAX_VISITED`
 *   (directory entries read) and `MAX_RESULTS` (matched resources). Either
 *   one crossed rejects the WHOLE query — never a silently truncated list —
 *   the same "a partial result must never read as a smaller true set"
 *   discipline `ZENDESK_SEARCH_LIMIT`/`GITHUB_SEARCH_LIMIT` already apply.
 * - A missing or unreadable `root` throws (fails the poll for that rule, same
 *   "any one rule's failed search rejects the whole poll" doctrine every
 *   other provider's `search*Rules` already has); a subdirectory that
 *   vanishes or turns unreadable mid-walk (a real filesystem changes under a
 *   poll) is skipped quietly instead — the tree beneath it just reports
 *   fewer matches this poll, not a failed one.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FilesystemPredicate, FilesystemQuery } from "./filesystem-query.js";

export interface FilesystemResource {
  /** Canonical absolute path — the resource id. */
  path: string;
  kind: "file" | "directory";
  /** Basename, for spawn summaries. */
  name: string;
  /** Bytes; 0 for a directory. */
  size: number;
  mtimeMs: number;
}

/** The filesystem facts discovery depends on, injectable so tests are deterministic — a temp directory tree plus an explicit poll tick, never a sleep-and-hope. */
export interface FilesystemIo {
  readdir(path: string): Promise<Dirent[]>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }>;
  realpath(path: string): Promise<string>;
}

export const realFilesystemIo: FilesystemIo = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
};

/** Directory entries read in one query's walk, across every directory visited — the traversal-cost cap, independent of how many actually match. */
export const MAX_VISITED = 200_000;
/** Matched resources one query may report — the result-size cap. */
export const MAX_RESULTS = 5_000;

/**
 * Wraps a root-resolution failure into the SAME "is not readable" Error
 * message every existing caller/test already depends on (unchanged, on
 * purpose — an ordinary `filesystem` rule's root failing the whole poll is
 * still exactly right; see docs/filesystem.md's "Safety"), while attaching
 * the underlying error's `.code` (`ENOENT`, `ENOTDIR`, `EACCES`, ...) as a
 * plain property. BUTCHR-408 review fix: this is the seam that lets ONE
 * caller (the managed-sessions loop, session-definition-type.ts) tell "the
 * well-known directory does not exist yet" (`ENOENT` — not an error, just
 * "no definitions") apart from "it exists but is unreadable, or is not a
 * directory" (anything else — still a real failure) WITHOUT changing this
 * function's own throwing behaviour or message shape for every other
 * caller.
 */
function rootUnreadable(root: string, cause: unknown): Error {
  return Object.assign(new Error(`filesystem root ${root} is not readable: ${(cause as Error)?.message ?? cause}`), { code: (cause as NodeJS.ErrnoException)?.code });
}

/** True for exactly the `listFilesystemResources` root-resolution failure that means "this root does not exist" — see `rootUnreadable`'s own doc comment for why this is `ENOENT` specifically, not "any listing error". */
export const isMissingRootError = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** `*`/`?` glob, anchored to the WHOLE basename (never `/`, since a validated `namePattern` never contains one). */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

async function predicateHolds(full: string, kind: "file" | "directory", predicate: FilesystemPredicate | undefined, io: FilesystemIo): Promise<boolean> {
  if (!predicate) return true;
  if (predicate.predicateKind === "extension") return kind === "file" && full.endsWith(predicate.value);
  // "hasEntry": a direct child of this (kind === "directory", enforced at validation) candidate.
  let entries: Dirent[];
  try { entries = await io.readdir(full); } catch { return false; }
  return entries.some((e) => e.name === predicate.name && (!predicate.entryKind || (predicate.entryKind === "directory" ? e.isDirectory() : e.isFile())));
}

/**
 * Every resource under `query.root` this query currently matches, or throws
 * (a missing/unreadable root, or either cap crossed) — never a partial list.
 */
export async function listFilesystemResources(query: FilesystemQuery, io: FilesystemIo = realFilesystemIo): Promise<FilesystemResource[]> {
  let root: string;
  try { root = await io.realpath(query.root); }
  catch (e) { throw rootUnreadable(query.root, e); }
  const pattern = query.namePattern ? globToRegExp(query.namePattern) : null;
  const results: FilesystemResource[] = [];
  let visited = 0;

  const consider = async (full: string, name: string, kind: "file" | "directory"): Promise<void> => {
    if (kind !== query.kind) return;
    if (pattern && !pattern.test(name)) return;
    if (!(await predicateHolds(full, kind, query.predicate, io))) return;
    const st = await io.lstat(full);
    results.push({ path: full, kind, name, size: kind === "file" ? st.size : 0, mtimeMs: st.mtimeMs });
    if (results.length > MAX_RESULTS) throw new Error(`filesystem query under ${query.root} matched over ${MAX_RESULTS} resources; narrow the query`);
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try { entries = await io.readdir(dir); }
    catch (e) {
      if (dir === root) throw rootUnreadable(query.root, e);
      return; // vanished or turned unreadable mid-walk — not the root; skip quietly, see this module's own top comment.
    }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) throw new Error(`filesystem query under ${query.root} visited over ${MAX_VISITED} entries; narrow the root, namePattern or maxDepth`);
      if (entry.isSymbolicLink()) continue; // never followed, never matched — see this module's own top comment.
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await consider(full, entry.name, "directory");
        if (depth < query.maxDepth) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        await consider(full, entry.name, "file");
      }
      // Anything else (fifo, socket, device) is neither a file nor a directory and matches nothing.
    }
  };

  await walk(root, 1);
  return results;
}
