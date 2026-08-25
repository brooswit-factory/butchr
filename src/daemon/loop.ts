import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import { activeKeys, changedKeys } from "../jira-watch/diff.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";

export interface LoopDeps {
  /** Fetch the assigned issues (active + recently changed) each poll. */
  search: () => Promise<JiraIssue[]>;
  herd: Herd;
  /** Nudge the agent working `issue` that its ticket changed. */
  notify: (issue: string) => void | Promise<void>;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/** Bring the herd in line with the desired active set: spawn the missing, stop the rest. */
export async function reconcileNow(herd: Herd, desired: ReadonlyMap<string, SpawnSpec>): Promise<void> {
  const plan = planReconcile(desired.keys(), await herd.runningIssues());
  for (const issue of plan.spawn) await herd.spawn(desired.get(issue)!);
  for (const issue of plan.stop) await herd.stop(issue);
}

/** The desired active set as spawn specs, keyed by issue. */
export const desiredFrom = (issues: readonly JiraIssue[]): Map<string, SpawnSpec> =>
  new Map(issues.filter((i) => activeKeys([i]).length).map((i) => [i.key, { key: i.key, issuetype: i.issuetype, summary: i.summary, parent: i.parent }]));

/**
 * The daemon's core loop. Every poll: fetch assigned issues and reconcile the
 * herd (idempotent — this is the periodic controller, correct after a restart).
 * On any change between polls: nudge each affected agent.
 */
export function startLoop(deps: LoopDeps): Stop {
  return watch<JiraIssue[]>(
    async () => {
      const issues = await deps.search();
      await reconcileNow(deps.herd, desiredFrom(issues));
      return issues;
    },
    async (next, prev) => {
      const byKey = new Map(next.map((i) => [i.key, i]));
      const notified = new Set<string>();
      for (const key of changedKeys(prev, next)) {
        // the issue's own agent…
        if (!notified.has(key)) { notified.add(key); await deps.notify(key); }
        // …and its parent's agent: reviews and results flow upward.
        const parent = byKey.get(key)?.parent ?? prev.find((i) => i.key === key)?.parent;
        if (parent && !notified.has(parent)) { notified.add(parent); await deps.notify(parent); }
      }
    },
    deps.intervalMs,
    deps.onError ? { onError: deps.onError } : {},
  );
}
