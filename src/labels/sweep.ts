import type { JiraIssue } from "../atlassian/types.js";
import { ALL_ADMISSION_LABEL_KEYS, ALL_AGENT_LABEL_KEYS, isActiveStatusLabel, isAgentLabel } from "./plan.js";
import type { LabelWriter } from "./sync.js";

export interface SweepDeps {
  /** Issues matching a JQL query — injected so this stays offline-testable, like AtlassianClient.search. */
  search: (jql: string) => Promise<JiraIssue[]>;
  jira: LabelWriter;
  log?: (line: string) => void;
}

/**
 * BUTCHR-144/BUTCHR-155/BUTCHR-352: the `labels IN (...)` clause is DERIVED
 * from `ALL_AGENT_LABEL_KEYS` and `ALL_ADMISSION_LABEL_KEYS` (./plan.ts), not
 * hand-maintained here — both arrays are anchored to their own governing
 * union via a value-level Record (see ./plan.ts's `ALL_AGENT_LABELS`/
 * `ALL_ADMISSION_LABELS` and their headers for why a bare `type` cannot do
 * this alone, and for what that anchor cannot see). Before BUTCHR-155, this
 * was a hand-written literal list of four values that never included
 * `agent:stalled` — a ticket carrying that label was never selected by this
 * sweep, so it kept the stale label indefinitely after going inactive while
 * the daemon was down. `admission:*` (BUTCHR-352) is exactly the same
 * stranding hazard on a second namespace — folded into the SAME clause from
 * day one rather than repeating BUTCHR-144's mistake on a new prefix. See
 * test/unit/labels-sweep.test.ts for the runtime check that this clause
 * really is built from both arrays, not merely consistent with them today.
 */
const SWEEP_JQL = `assignee = currentUser() AND status NOT IN ("In Progress", "In Review") AND labels IN (${[...ALL_AGENT_LABEL_KEYS, ...ALL_ADMISSION_LABEL_KEYS].map((l) => `"${l}"`).join(", ")})`;

// Deliberately excludes agent:none: it is the normal, current statement that
// an active ticket is awaiting an agent, not evidence of a departed pane.
// The selection still derives from the single value-level agent-label anchor.
const STALE_LIVE_AGENT_LABEL_KEYS = ALL_AGENT_LABEL_KEYS.filter((label) => label !== "agent:none");
const LIVE_SWEEP_JQL = `assignee = currentUser() AND labels IN (${STALE_LIVE_AGENT_LABEL_KEYS.map((l) => `"${l}"`).join(", ")})`;

export interface LiveSweepDeps extends SweepDeps {
  /** Keys with a live pane in this daemon's herd snapshot for this poll. */
  liveKeys: ReadonlySet<string>;
  /** This poll's rule-owned tickets, which are safe to reconcile regardless of assignee. */
  ownedKeys: ReadonlySet<string>;
  /** Feed successful label writes into the daemon's existing own-write ledger. */
  onWrite?: (keys: readonly string[]) => void;
}

/**
 * Reconciles labels that claim a live agent against this daemon's fresh herd
 * snapshot. The JQL is assignee-scoped, so this daemon never purges a ticket
 * owned by another daemon merely because that daemon's panes are invisible
 * here. Label writes use the caller's ordinary LabelWriter, which is already
 * the daemon's quiet/own-write-silenced label path.
 */
export async function sweepAbsentLiveAgentLabels(deps: LiveSweepDeps): Promise<void> {
  const owned = [...deps.ownedKeys];
  const ownershipJql = owned.length ? `(assignee = currentUser() OR key IN (${owned.join(", ")}))` : "assignee = currentUser()";
  const issues = await deps.search(`${ownershipJql} AND ${LIVE_SWEEP_JQL.replace("assignee = currentUser() AND ", "")}`);
  const written: string[] = [];
  for (const issue of issues) {
    if (deps.liveKeys.has(issue.key)) continue;
    const remove = issue.labels.filter(isAgentLabel);
    if (!remove.length) continue;
    await deps.jira.updateLabels(issue.key, { remove });
    written.push(issue.key);
    deps.log?.(`[labels] ${issue.key} ${remove.map((l) => `-${l}`).join(" ")} (live-pane reconcile: no live owned pane)`);
  }
  if (written.length) deps.onWrite?.(written);
}

/**
 * One-time startup sweep for `agent:*`/`admission:*` labels (BUTCHR-352:
 * both are lifecycle-bound to active status — see `isActiveStatusLabel`'s own
 * doc comment) stranded by a ticket that went inactive while the daemon was
 * down. `createLabelSync`'s bookkeeping is in-memory and its only source of
 * issues (the 15s poll) is scoped to active statuses, so neither one ever
 * revisits a ticket that left the active set before this process started —
 * this sweep is the only thing that does. `pr:*` is deliberately left alone:
 * it isn't tied to active status.
 */
export async function sweepStaleAgentLabels(deps: SweepDeps): Promise<void> {
  const issues = await deps.search(SWEEP_JQL);
  for (const issue of issues) {
    const remove = issue.labels.filter(isActiveStatusLabel);
    if (!remove.length) continue;
    await deps.jira.updateLabels(issue.key, { remove });
    deps.log?.(`[labels] ${issue.key} ${remove.map((l) => `-${l}`).join(" ")} (startup sweep: inactive, stale from a prior run)`);
  }
}
