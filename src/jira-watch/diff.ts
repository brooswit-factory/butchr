import type { JiraIssue } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";
import { isDaemonLabel, isPrLabel, PR_PREFIX } from "../labels/plan.js";

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

/**
 * The ticket's single pr:* label value (the suffix after "pr:"), or null when
 * it carries none. Two pr:* labels shouldn't happen — `desiredLabels`
 * (src/labels/plan.ts) emits at most one — but if it ever did, the
 * sorted-first is used deterministically rather than guessing intent.
 */
function prLabelValue(issue: JiraIssue): string | null {
  const values = issue.labels.filter(isPrLabel).sort();
  return values.length ? values[0]!.slice(PR_PREFIX.length) : null;
}

/**
 * Whether `before` -> `after` (same ticket) is a pr:* TRANSITION: the
 * ticket's pr:* label after the poll differs from before, AND there IS a
 * pr:* label after. Counts none->open, open->approved, open->changes-requested,
 * changes-requested->approved, approved->merged, etc. A pure REMOVAL (pr:x ->
 * no pr:* label at all — a PR closed unmerged, or the KAN-814 restart
 * artefact) is deliberately NOT a transition and returns null — it never
 * wakes anyone. Status/summary changes are irrelevant to this rule: a pr:*
 * transition nested inside a larger diff (status changed too) still counts —
 * unlike isDaemonLabelOnlyDiff, this never gates on status/summary equality.
 * Pure.
 */
export function prTransition(before: JiraIssue, after: JiraIssue): { from: string | null; to: string } | null {
  const to = prLabelValue(after);
  if (to === null) return null;
  const from = prLabelValue(before);
  if (from === to) return null;
  return { from, to };
}
