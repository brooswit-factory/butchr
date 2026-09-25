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
 */
const MAX_PATH_LENGTH = 4096;

export function isFilesystemResourceId(id: string): boolean {
  if (!id || id.length > MAX_PATH_LENGTH || id.includes("\0")) return false;
  if (id === "/") return true;
  if (id[0] !== "/" || id.endsWith("/")) return false;
  const segments = id.slice(1).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}
