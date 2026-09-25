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
 */
const MAX_PATH_LENGTH = 4096;

export function isFilesystemResourceId(id: string): boolean {
  if (!id || id.length > MAX_PATH_LENGTH || id.includes("\0")) return false;
  if (id === "/") return true;
  if (id[0] !== "/" || id.endsWith("/")) return false;
  const segments = id.slice(1).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}
