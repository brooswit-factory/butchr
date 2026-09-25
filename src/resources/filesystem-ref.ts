/**
 * The `filesystem` provider's resource identity, dependency-free so the agent
 * key codec (src/rules/agent-key.ts) can import it without loading any
 * filesystem I/O — same house pattern as github-issue-ref.ts/zendesk-ticket-ref.ts.
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
