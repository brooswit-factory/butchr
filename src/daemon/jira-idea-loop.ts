/**
 * The daemon's `jira-idea` rule loop, run beside the Jira work and GitHub
 * issue loops over the same herd. Kept out of src/daemon/index.ts so the
 * wiring itself is testable.
 *
 * It searches through the same Jira client as `jira-work` but staffs only
 * proven Product Discovery ideas (src/rules/jira-idea-type.ts), and gets none
 * of the work loop's label sync, parked/abandoned/stall detectors, or
 * respawn and crash-loop comments — those write work-item conventions onto
 * the ticket. `ownsId` scopes reconciliation to `jira-idea` agents, and the
 * other loops scope themselves, so no loop can stop another's agents.
 */
import type { Herd } from "../agents/herd.js";
import { jiraIdeaNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { JiraComment, JiraIssue } from "../atlassian/types.js";
import type { NotifyReason } from "../resources/types.js";
import { createJiraIdeaResourceType, ownsJiraIdeaAgent } from "../rules/jira-idea-type.js";
import type { Rule } from "../rules/rules.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Same cadence as the Jira work rule loop. */
export const JIRA_IDEA_POLL_MS = 15_000;

export interface JiraIdeaLoopDeps {
  /** All validated rules; only enabled `jira-idea` rules run. */
  rules: readonly Rule[];
  /** Every issue a JQL matches, all pages (AtlassianClient#searchAll) — never a partial list. */
  search: (jql: string) => Promise<JiraIssue[]>;
  /** Recent comments, newest first (AtlassianClient#comments) — for change reasons and echo checks. */
  comments?: (key: string) => Promise<readonly JiraComment[]>;
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  log: (line: string) => void;
  intervalMs?: number;
}

/** The enabled `jira-idea` rules, in file order. */
export const jiraIdeaRules = (rules: readonly Rule[]): Rule[] => rules.filter((r) => r.enabled && r.resourceProvider === "jira-idea");

/** Starts the loop when any `jira-idea` rule is enabled; otherwise starts nothing. */
export function startJiraIdeaLoop(deps: JiraIdeaLoopDeps): Stop | null {
  const rules = jiraIdeaRules(deps.rules);
  if (!rules.length) return null;
  const type = createJiraIdeaResourceType({
    rules,
    search: deps.search,
    ...(deps.comments ? { comments: deps.comments } : {}),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    log: deps.log,
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsJiraIdeaAgent,
    notify: async (agent: string, _about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(agent);
      await deps.deliver(agent, resource, jiraIdeaNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? JIRA_IDEA_POLL_MS,
    onError: (e) => deps.log(`[jira-idea] loop error: ${(e as Error)?.message ?? e}`),
  });
}
