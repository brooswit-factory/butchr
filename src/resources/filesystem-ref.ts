/**
 * NAMING/FILE COLLISION RECORDED HERE ON PURPOSE (found during BUTCHR-408's
 * rebase onto `main`, 2026-09-25): this file now serves TWO independent
 * subsystems that happened to pick the same module name on diverging
 * branches, for related but distinct concepts, both spelled `filesystem`:
 *
 * 1. FACTORY-7's `ResourceRef` kind (below, unchanged from `main`) — the
 *    canonical identity for a `filesystem` entry in the generic cross-issue
 *    LINK system (`src/resources/resource-ref.ts`, `butchr link` CLI). It
 *    NORMALIZES a possibly-relative-looking, `.`/`..`-bearing path itself
 *    (`parseFilesystemRef`), because a human can type `butchr link add
 *    filesystem:/a/../b` and expects that to resolve, not to be rejected.
 *
 * 2. BUTCHR-407/BUTCHR-408's `filesystem` RESOURCE PROVIDER identity (at the
 *    bottom of this file) — the agent key codec's (`src/rules/agent-key.ts`)
 *    notion of what a valid, already-canonical filesystem resource id looks
 *    like. It REJECTS `.`/`..` segments outright rather than normalizing
 *    them, because by the time a path reaches this check, discovery has
 *    already resolved it through `realpath` (see that function's own doc
 *    comment) — a provider-identity check must never silently accept a
 *    not-yet-canonical path.
 *
 * Same "two similarly-named things must never be confused for each other"
 * discipline `resource-ref.ts`'s own header applies to `ResourceProvider`
 * vs. `ResourceRefProvider`: these two exports are for different callers,
 * are validated differently on purpose, and must not be merged into one
 * function just because they share a domain concept (a filesystem path).
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

/**
 * The `filesystem` RESOURCE PROVIDER's own resource identity (BUTCHR-407),
 * dependency-free so the agent key codec (src/rules/agent-key.ts) can import
 * it without loading any filesystem I/O — same house pattern as
 * github-issue-ref.ts/zendesk-ticket-ref.ts. See this file's own top comment
 * for why this is deliberately NOT the same function as `isFilesystemRef`
 * above, despite both being about a filesystem path.
 *
 * A resource is identified by its canonical absolute path: no `~`, no `.`/`..`
 * segments, no repeated slashes, no trailing slash (except the bare root `/`,
 * which this provider never actually reports as a resource — see
 * src/resources/filesystem.ts's own top comment), no NUL byte. Two spellings
 * of the same file (a relative path, a path reached through a symlink) must
 * never become two agents: discovery resolves every candidate through
 * `realpath` and never follows a symlink, so by the time a path reaches this
 * check it is already the one real path the OS resolves the resource to.
 *
 * REVIEW FINDING (PR #388 round 1): `workspaceDirFor` (src/agents/workspace.ts)
 * makes the WHOLE agent key one directory name per segment — for a filesystem
 * resource that means `encodeURIComponent(id)` as ONE path component. Every
 * mainstream Linux filesystem caps a single directory-name component at
 * `NAME_MAX` = 255 BYTES, and percent-encoding INFLATES size: every `/`
 * becomes `%2F` (3 bytes) and every non-ASCII character becomes 6+ bytes. A
 * path that looks like a perfectly good absolute path can still encode to a
 * segment over that limit — `mkdirSync` then throws `ENAMETOOLONG` on every
 * poll, for a resource discovery legitimately reported and `encodeAgentKey`
 * legitimately accepted. So THIS is the real, load-bearing limit — a raw
 * character-count cap (this module's previous `MAX_PATH_LENGTH = 4096`) does
 * not protect against it (a short but heavily non-ASCII path can already
 * exceed it; see `MAX_ENCODED_SEGMENT_BYTES` below) and is dropped rather than
 * kept alongside a stricter, more relevant check: for any character in this
 * codec's charset, `encodeURIComponent` never shrinks size (an unreserved
 * character costs 1 byte, everything else 3+), so a raw length over
 * `MAX_ENCODED_SEGMENT_BYTES` already implies an encoded length over it too —
 * the old check could never have rejected an id this one wouldn't already
 * reject. `searchFilesystemRules` (src/rules/filesystem-type.ts) is what
 * SKIPS (never throws) a resource this predicate rejects, logging why once.
 */
export const MAX_ENCODED_SEGMENT_BYTES = 255;

export function isFilesystemResourceId(id: string): boolean {
  if (!id || id.includes("\0")) return false;
  if (id === "/") return true;
  if (id[0] !== "/" || id.endsWith("/")) return false;
  const segments = id.slice(1).split("/");
  if (!segments.every((s) => s !== "" && s !== "." && s !== "..")) return false;
  return Buffer.byteLength(encodeURIComponent(id), "utf8") <= MAX_ENCODED_SEGMENT_BYTES;
}
