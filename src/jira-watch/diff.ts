import type { JiraIssue } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";

/** Keys of issues currently in an active status. */
export const activeKeys = (issues: readonly JiraIssue[]): string[] =>
  issues.filter((i) => isActive(i.status)).map((i) => i.key);

/**
 * Which issues meaningfully changed between two polls — a new key, a gone key,
 * or a field that agents care about (status/summary/updated). Pure; drives
 * which agents get a "your ticket changed" nudge.
 */
export function changedKeys(prev: readonly JiraIssue[], next: readonly JiraIssue[]): string[] {
  const before = new Map(prev.map((i) => [i.key, i]));
  const changed = new Set<string>();
  for (const i of next) {
    const b = before.get(i.key);
    if (!b || b.status !== i.status || b.summary !== i.summary || b.updated !== i.updated) changed.add(i.key);
    before.delete(i.key);
  }
  for (const goneKey of before.keys()) changed.add(goneKey); // disappeared from the feed
  return [...changed].sort();
}
