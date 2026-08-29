import type { JiraIssue } from "../atlassian/types.js";
import { AGENT_PREFIX, desiredLabels, diffLabels, isDaemonLabel, type PrState } from "./plan.js";

export interface LabelWriter {
  updateLabels(key: string, ops: { add?: readonly string[]; remove?: readonly string[] }): Promise<void>;
}

export interface SyncDeps {
  jira: LabelWriter;
  /** issue key -> raw herdr agent_status, for every currently running butchr agent. */
  agentStatuses: () => Promise<ReadonlyMap<string, string>>;
  /** Per-ticket PR state; omitted (or always resolving null) when pr:* is disabled. */
  prState?: (key: string) => Promise<PrState>;
  log?: (line: string) => void;
}

/**
 * Builds the level-style label reconciler: given this poll's issues, computes
 * each one's desired daemon-owned label set and writes only the diff — at
 * most one Jira request per issue, none when nothing changed.
 *
 * `search()` (the daemon's only source of issues) is scoped to active
 * statuses, so a ticket that leaves the active set simply stops appearing —
 * there is no "it changed to Done" event to react to. This reconciler tracks
 * the last label set it wrote for each ticket it has seen, so that on the
 * poll where a ticket disappears it can still issue the agent:* removal
 * (pr:* is untouched — it isn't tied to active status).
 */
export function createLabelSync(deps: SyncDeps) {
  const lastLabels = new Map<string, string[]>();

  const write = async (written: Set<string>, key: string, current: readonly string[], desired: readonly string[]) => {
    const diff = diffLabels(desired, current);
    if (!diff.add.length && !diff.remove.length) return;
    await deps.jira.updateLabels(key, diff);
    written.add(key);
    const parts = [...diff.add.map((l) => `+${l}`), ...diff.remove.map((l) => `-${l}`)];
    deps.log?.(`[labels] ${key} ${parts.join(" ")}`);
  };

  return async function syncLabels(issues: readonly JiraIssue[]): Promise<ReadonlySet<string>> {
    const written = new Set<string>();
    const seen = new Set(issues.map((i) => i.key));
    const agents = await deps.agentStatuses();

    for (const issue of issues) {
      const prState = deps.prState ? await deps.prState(issue.key) : null;
      const desired = desiredLabels({ status: issue.status, agentStatus: agents.get(issue.key) ?? null, prState });
      await write(written, issue.key, issue.labels, desired);
      lastLabels.set(issue.key, [...issue.labels.filter((l) => !isDaemonLabel(l)), ...desired]);
    }

    for (const key of [...lastLabels.keys()]) {
      if (seen.has(key)) continue;
      const current = lastLabels.get(key)!;
      const desired = current.filter((l) => !l.startsWith(AGENT_PREFIX));
      await write(written, key, current, desired);
      lastLabels.delete(key);
    }

    return written;
  };
}
