/**
 * FACTORY-57 (implementing FACTORY-56, epic FACTORY-55): the daemon's third
 * rule loop: `github-pr` rules, run beside the Jira and `github-issue`
 * loops over the same herd. Deliberate mirror of `./github-issue-loop.ts` —
 * see that module's own header for the shared design this one repeats.
 *
 * What it deliberately does NOT get, same reasoning as `github-issue-loop.ts`:
 * label sync, the parked/abandoned/stall detectors, respawn and crash-loop
 * comments. Every one of those writes to Jira, and a GitHub pull request is
 * not a Jira ticket. `ownsId` scopes reconciliation to `github-pr` agents,
 * and the other loops scope themselves to their own providers, so none can
 * stop another's.
 */
import type { Herd } from "../agents/herd.js";
import type { AccountLifecycleHooks } from "../agents/account-lifecycle.js";
import { githubPrNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { GithubPrClient } from "../resources/github-pr.js";
import type { NotifyReason } from "../resources/types.js";
import { createGithubPrResourceType, ownsGithubPrAgent, type GithubPrMatch, type GithubPrStaffing } from "../rules/github-pr-type.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Same rate-limit reasoning as `GITHUB_ISSUE_POLL_MS`: GitHub search allows 30 authenticated requests a minute; one poll a minute leaves room for several rules and pages, shared with the issue loop's own budget. */
export const GITHUB_PR_POLL_MS = 60_000;

export interface GithubPrLoopDeps {
  staffing: GithubPrStaffing;
  client: Pick<GithubPrClient, "searchAll" | "comments">;
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  reserveAdmission?: (ids: readonly string[]) => void;
  releaseAdmission?: (ids: readonly string[]) => Promise<void>;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  /** See `ReconcileOptions.account`'s doc comment (src/daemon/loop.ts) — threaded straight through. Optional; omitted, no account lifecycle runs. */
  account?: AccountLifecycleHooks;
  log: (line: string) => void;
  intervalMs?: number;
  /** Each completed poll, for /health. */
  onPollSuccess?: () => void;
  /** Each failed poll (after it is logged), for /health. */
  onError?: (error: unknown) => void;
}

/**
 * Starts the loop. When staffing does not allow github-pr rules it logs why
 * (if there is anything to say) and runs with NO rules: nothing is searched
 * or spawned, but `github-pr` agents left over from an earlier run (a rule
 * since disabled, GitHub config since removed) are stopped rather than left
 * running with no tools and no loop to stop them.
 */
export function startGithubPrLoop(deps: GithubPrLoopDeps): Stop {
  if (!deps.staffing.run && deps.staffing.reason) deps.log(`WARNING: ${deps.staffing.reason}`);
  const type = createGithubPrResourceType({
    rules: deps.staffing.run ? deps.staffing.rules : [],
    search: (query) => deps.client.searchAll(query),
    comments: (ref) => deps.client.comments(ref),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsGithubPrAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsGithubPrAgent,
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, githubPrNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    ...(deps.account ? { account: deps.account } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? GITHUB_PR_POLL_MS,
    onError: (e) => {
      deps.log(`[github-pr] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
