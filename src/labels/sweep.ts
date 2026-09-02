import type { JiraIssue } from "../atlassian/types.js";
import { ALL_AGENT_LABEL_KEYS, isAgentLabel } from "./plan.js";
import type { LabelWriter } from "./sync.js";

export interface SweepDeps {
  /** Issues matching a JQL query — injected so this stays offline-testable, like AtlassianClient.search. */
  search: (jql: string) => Promise<JiraIssue[]>;
  jira: LabelWriter;
  log?: (line: string) => void;
}

/**
 * BUTCHR-144/BUTCHR-155: the `labels IN (...)` clause is DERIVED from
 * `ALL_AGENT_LABEL_KEYS` (./plan.ts), not hand-maintained here — that array
 * is itself anchored to the `AgentLabel` union via a value-level Record (see
 * ./plan.ts's `ALL_AGENT_LABELS` and its header for why a bare `type` cannot
 * do this alone, and for what that anchor cannot see). Before BUTCHR-155,
 * this was a hand-written literal list of four values that never included
 * `agent:stalled` — a ticket carrying that label was never selected by this
 * sweep, so it kept the stale label indefinitely after going inactive while
 * the daemon was down. See test/unit/labels-sweep.test.ts for the runtime
 * check that this clause really is built from that array, not merely
 * consistent with it today.
 */
const SWEEP_JQL = `assignee = currentUser() AND status NOT IN ("In Progress", "In Review") AND labels IN (${ALL_AGENT_LABEL_KEYS.map((l) => `"${l}"`).join(", ")})`;

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
