import type { JiraIssue } from "../atlassian/types.js";
import { isAgentLabel } from "./plan.js";
import type { LabelWriter } from "./sync.js";

export interface SweepDeps {
  /** Issues matching a JQL query — injected so this stays offline-testable, like AtlassianClient.search. */
  search: (jql: string) => Promise<JiraIssue[]>;
  jira: LabelWriter;
  log?: (line: string) => void;
}

const SWEEP_JQL = 'assignee = currentUser() AND status NOT IN ("In Progress", "In Review") AND labels IN ("agent:working", "agent:idle", "agent:blocked", "agent:none")';

/**
 * One-time startup sweep for `agent:*` labels stranded by a ticket that went
 * inactive while the daemon was down. `createLabelSync`'s bookkeeping is
 * in-memory and its only source of issues (the 15s poll) is scoped to active
 * statuses, so neither one ever revisits a ticket that left the active set
 * before this process started — this sweep is the only thing that does.
 * `pr:*` is deliberately left alone: it isn't tied to active status.
 */
export async function sweepStaleAgentLabels(deps: SweepDeps): Promise<void> {
  const issues = await deps.search(SWEEP_JQL);
  for (const issue of issues) {
    const remove = issue.labels.filter(isAgentLabel);
    if (!remove.length) continue;
    await deps.jira.updateLabels(issue.key, { remove });
    deps.log?.(`[labels] ${issue.key} ${remove.map((l) => `-${l}`).join(" ")} (startup sweep: inactive, stale from a prior run)`);
  }
}
