/**
 * The daemon's second rule loop: `github-issue` rules, run beside the Jira
 * rule loop over the same herd. Kept out of src/daemon/index.ts so the
 * wiring itself is testable.
 *
 * What it deliberately does NOT get from the Jira loop: label sync, the
 * parked/abandoned/stall detectors, respawn and crash-loop comments. Every
 * one of those writes to Jira, and a GitHub issue is not a Jira ticket.
 * `ownsId` scopes reconciliation to `github-issue` agents, and the Jira loop
 * scopes itself to `jira-work` agents, so neither loop can stop the other's.
 */
import type { Herd } from "../agents/herd.js";
import { githubIssueNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { GithubIssueClient } from "../resources/github-issue.js";
import type { NotifyReason } from "../resources/types.js";
import { createGithubIssueResourceType, ownsGithubIssueAgent, type GithubIssueStaffing } from "../rules/github-issue-type.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** GitHub search allows 30 authenticated requests a minute; one poll a minute leaves room for several rules and pages. */
export const GITHUB_ISSUE_POLL_MS = 60_000;

export interface GithubIssueLoopDeps {
  staffing: GithubIssueStaffing;
  client: Pick<GithubIssueClient, "searchAll" | "comments">;
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  log: (line: string) => void;
  intervalMs?: number;
}

/** Starts the loop when staffing allows it; otherwise logs why (if there is anything to say) and starts nothing. */
export function startGithubIssueLoop(deps: GithubIssueLoopDeps): Stop | null {
  if (!deps.staffing.run) {
    if (deps.staffing.reason) deps.log(`WARNING: ${deps.staffing.reason}`);
    return null;
  }
  const type = createGithubIssueResourceType({
    rules: deps.staffing.rules,
    search: (query) => deps.client.searchAll(query),
    comments: (ref) => deps.client.comments(ref),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    log: deps.log,
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsGithubIssueAgent,
    notify: async (agent: string, _about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(agent);
      await deps.deliver(agent, resource, githubIssueNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? GITHUB_ISSUE_POLL_MS,
    onError: (e) => deps.log(`[github-issue] loop error: ${(e as Error)?.message ?? e}`),
  });
}
