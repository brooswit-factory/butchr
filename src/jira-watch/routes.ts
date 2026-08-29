import type { IssueLink } from "../atlassian/types.js";

/**
 * KAN-765 deprecation window: while true, a "Relates" link routes in either
 * direction (today's behavior, narrowed to just this one type). Release B
 * (KAN-769) deletes this constant and the branch in watchedKeys() that reads
 * it — flip to false first if a staged removal is ever wanted, then delete.
 */
export const ROUTE_RELATES_DEPRECATED = true;

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
 * - "Relates", either direction: routed only while ROUTE_RELATES_DEPRECATED.
 * - Everything else (Blocks, Cloners, Duplicate, unknown types): not routed.
 */
export function watchedKeys(links: readonly IssueLink[]): string[] {
  return links
    .filter((l) => (l.type === "Implements" && l.otherEnd === "outward") || (ROUTE_RELATES_DEPRECATED && l.type === "Relates"))
    .map((l) => l.key);
}
