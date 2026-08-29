import type { JiraIssue } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";
import { isDaemonLabel } from "../labels/plan.js";

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

/**
 * Whether `before` -> `after` (same ticket) changed ONLY daemon-namespaced
 * labels (agent:*, pr:* — see src/labels/plan.ts) — status and summary
 * unchanged, and every added/removed label is daemon-owned. Only a daemon
 * ever writes those labels, so a diff confined to them can be treated as a
 * daemon write from ANY daemon — the cross-daemon echo case own-writes.ts's
 * caller uses this for (a local per-daemon write ledger can't know about a
 * write another daemon made). False whenever there is no label change at
 * all: that case belongs to the exact-`updated`-match ledger, not this rule.
 */
export function isDaemonLabelOnlyDiff(before: JiraIssue, after: JiraIssue): boolean {
  if (before.status !== after.status || before.summary !== after.summary) return false;
  const b = new Set(before.labels), a = new Set(after.labels);
  const changedLabels = [...b].filter((l) => !a.has(l)).concat([...a].filter((l) => !b.has(l)));
  return changedLabels.length > 0 && changedLabels.every(isDaemonLabel);
}
