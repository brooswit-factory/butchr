import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import { activeKeys, changedKeys } from "../jira-watch/diff.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";

/** A ticket watched on behalf of active issues via the Implements chain (see src/jira-watch/routes.ts). */
export interface RelatedIssue {
  issue: JiraIssue;
  /** Active issue keys whose agents should hear when this ticket changes. */
  watchers: readonly string[];
}

export interface LoopDeps {
  /** Fetch the assigned issues (active + recently changed) each poll. */
  search: () => Promise<JiraIssue[]>;
  /**
   * Fetch tickets related to the active set via the Implements chain (plus
   * the Relates deprecation window — see src/jira-watch/routes.ts), with the
   * active keys that watch each. Related tickets are watched regardless of
   * assignee, so a hierarchy can span credentials (and machines): a boss
   * hears about its implementer's progress even when another daemon staffs it.
   */
  related?: (active: readonly string[]) => Promise<RelatedIssue[]>;
  herd: Herd;
  /** Nudge the agent working `issue`; `about` is the ticket that changed (not always its own). */
  notify: (issue: string, about: string) => void | Promise<void>;
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

interface Snapshot { issues: JiraIssue[]; related: RelatedIssue[] }

/**
 * The daemon's core loop. Every poll: fetch assigned issues, reconcile the herd
 * (idempotent — this is the periodic controller, correct after a restart), and
 * fetch the work related to what's active. On any change between polls: nudge
 * each affected agent, naming the ticket that changed.
 */
export function startLoop(deps: LoopDeps): Stop {
  return watch<Snapshot>(
    async () => {
      const issues = await deps.search();
      const desired = desiredFrom(issues);
      await reconcileNow(deps.herd, desired);
      const related = deps.related ? await deps.related([...desired.keys()]) : [];
      return { issues, related };
    },
    async (next, prev) => {
      const sent = new Set<string>();
      const send = async (issue: string, about: string) => {
        const id = `${issue}|${about}`;
        if (sent.has(id)) return;
        sent.add(id);
        await deps.notify(issue, about);
      };
      // Assigned issues: notify the issue's own agent only. Parent is membership
      // only (not an event to listen for) — a boss hears change only through
      // the Implements chain below, via routes.ts.
      for (const key of changedKeys(prev.issues, next.issues)) await send(key, key);
      // Related work (the Implements chain, plus the Relates deprecation window):
      // notify every watcher of what changed.
      const watchersOf = (k: string) =>
        next.related.find((r) => r.issue.key === k)?.watchers ?? prev.related.find((r) => r.issue.key === k)?.watchers ?? [];
      for (const key of changedKeys(prev.related.map((r) => r.issue), next.related.map((r) => r.issue)))
        for (const w of watchersOf(key)) await send(w, key);
    },
    deps.intervalMs,
    deps.onError ? { onError: deps.onError } : {},
  );
}
