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
import type { AccountLifecycleHooks } from "../agents/account-lifecycle.js";
import { githubIssueNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { GithubIssueClient } from "../resources/github-issue.js";
import type { NotifyReason } from "../resources/types.js";
import { createGithubIssueResourceType, ownsGithubIssueAgent, type GithubIssueMatch, type GithubIssueStaffing } from "../rules/github-issue-type.js";
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
  reserveAdmission?: (ids: readonly string[]) => void;
  releaseAdmission?: (ids: readonly string[]) => Promise<void>;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  /** BUTCHR-412: see `ReconcileOptions.account`'s doc comment (src/daemon/loop.ts) — threaded straight through. Optional; omitted, no account lifecycle runs. */
  account?: AccountLifecycleHooks;
  log: (line: string) => void;
  intervalMs?: number;
  /** Each completed poll, for /health. */
  onPollSuccess?: () => void;
  /** Each failed poll (after it is logged), for /health. */
  onError?: (error: unknown) => void;
  /** Each complete poll's matches, for jira-idea rules that hear github-issue rules. */
  onMatches?: (matches: readonly GithubIssueMatch[]) => void;
}

/**
 * Starts the loop. When staffing does not allow github-issue rules it logs
 * why (if there is anything to say) and runs with NO rules: nothing is
 * searched or spawned, but `github-issue` agents left over from an earlier
 * run (a rule since disabled, GitHub config since removed) are stopped
 * rather than left running with no tools and no loop to stop them.
 */
export function startGithubIssueLoop(deps: GithubIssueLoopDeps): Stop {
  if (!deps.staffing.run && deps.staffing.reason) deps.log(`WARNING: ${deps.staffing.reason}`);
  const type = createGithubIssueResourceType({
    rules: deps.staffing.run ? deps.staffing.rules : [],
    search: (query) => deps.client.searchAll(query),
    comments: (ref) => deps.client.comments(ref),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    ...(deps.onMatches ? { onMatches: deps.onMatches } : {}),
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsGithubIssueAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsGithubIssueAgent,
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      // BUTCHR-398: `about` names the CHANGED issue — for a swarm agent's
      // own primary change this is always `agent` itself (`resourceKeyOf`
      // recovers the same ticket either way), but for a `singleton`/
      // `persistent` rule's own scope entry `about` is a DIFFERENT ticket
      // than the query agent's own key. Using `resourceKeyOf(agent)`
      // unconditionally (as before this ticket, when `about` was always
      // `agent` and so never mattered) would push the query agent's own
      // bogus key (`github-issue:<rule>:%40query`) as if it were a real issue
      // ref — the exact hazard this ticket's `resourceKeyOf` audit exists to
      // close, here in notification text rather than a live API call.
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, githubIssueNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    ...(deps.account ? { account: deps.account } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? GITHUB_ISSUE_POLL_MS,
    onError: (e) => {
      deps.log(`[github-issue] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
