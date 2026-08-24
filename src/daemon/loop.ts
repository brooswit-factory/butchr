import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import { activeKeys, changedKeys } from "../jira-watch/diff.js";
import type { Herd } from "../agents/herd.js";

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
export async function reconcileNow(herd: Herd, desiredActive: Iterable<string>): Promise<void> {
  const plan = planReconcile(desiredActive, await herd.runningIssues());
  for (const issue of plan.spawn) await herd.spawn(issue);
  for (const issue of plan.stop) await herd.stop(issue);
}

/**
 * The daemon's core loop. Every poll: fetch assigned issues and reconcile the
 * herd (idempotent — this is the periodic controller, correct after a restart).
 * On any change between polls: nudge each affected agent.
 */
export function startLoop(deps: LoopDeps): Stop {
  return watch<JiraIssue[]>(
    async () => {
      const issues = await deps.search();
      await reconcileNow(deps.herd, activeKeys(issues));
      return issues;
    },
    async (next, prev) => {
      for (const issue of changedKeys(prev, next)) await deps.notify(issue);
    },
    deps.intervalMs,
    deps.onError ? { onError: deps.onError } : {},
  );
}
