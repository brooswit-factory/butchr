import type { IssueLink } from "../atlassian/types.js";

/**
 * Given ONE active key's links, the other-end keys that active key should
 * watch. Pure and total — the whole routing decision lives here so it is
 * unit-testable with no fake Jira and no timers.
 *
 * Rules:
 * - "Implements", other end on the IMPLEMENTER side (otherEnd === "outward"):
 *   routed — a boss (story/epic) hears what implements it.
 * - "Implements", other end on the BOSS side (otherEnd === "inward"): NOT
 *   routed — an implementer must not hear its own boss through this link
 *   (e.g. a story must not hear its epic via story-implements-epic).
 * - Everything else (Relates, Blocks, Cloners, Duplicate, unknown types):
 *   not routed.
 */
export function watchedKeys(links: readonly IssueLink[]): string[] {
  return links
    .filter((l) => l.type === "Implements" && l.otherEnd === "outward")
    .map((l) => l.key);
}
