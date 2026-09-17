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
 *
 * Idea agents also hear the GitHub issues their ideas link to, when their
 * rule lists the matching `github-issue` rule (src/rules/jira-idea-type.ts).
 * The GitHub loop's matches are read, never searched again here.
 */
import type { Herd } from "../agents/herd.js";
import { jiraIdeaLinkedGithubNudge, jiraIdeaNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { JiraComment, JiraIssue } from "../atlassian/types.js";
import type { LinkedGithubIssue } from "../resources/jira-idea.js";
import type { NotifyReason } from "../resources/types.js";
import { decodeAgentKey } from "../rules/agent-key.js";
import type { GithubIssueMatch, GithubIssueResourceDeps } from "../rules/github-issue-type.js";
import { createJiraIdeaResourceType, ownsJiraIdeaAgent } from "../rules/jira-idea-type.js";
import type { RuleMatch } from "../rules/resource-type.js";
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
  /** The github-issue loop's latest matches; omitted when that loop is not running, and then nothing is heard. */
  githubMatches?: () => readonly GithubIssueMatch[];
  /** The GitHub issues an idea's Jira remote links name (JiraIdeaClient#githubIssues). */
  githubLinks?: (ideaKey: string) => Promise<readonly LinkedGithubIssue[]>;
  githubComments?: GithubIssueResourceDeps["comments"];
  /** Told each poll's complete idea matches (for the link tools' rule checks). */
  onMatches?: (matches: readonly RuleMatch[]) => void;
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  log: (line: string) => void;
  intervalMs?: number;
  /** Each completed poll, for /health. */
  onPollSuccess?: () => void;
  /** Each failed poll (after it is logged), for /health. */
  onError?: (error: unknown) => void;
}

/** The enabled `jira-idea` rules, in file order. */
export const jiraIdeaRules = (rules: readonly Rule[]): Rule[] => rules.filter((r) => r.enabled && r.resourceProvider === "jira-idea");

/**
 * Starts the loop. With no enabled `jira-idea` rule it searches nothing and
 * spawns nothing, but still stops `jira-idea` agents left over from an
 * earlier run (a rule since disabled or removed) — never leaves them running
 * with no tools and no loop to stop them.
 */
export function startJiraIdeaLoop(deps: JiraIdeaLoopDeps): Stop {
  const rules = jiraIdeaRules(deps.rules);
  const type = createJiraIdeaResourceType({
    rules,
    search: deps.search,
    ...(deps.comments ? { comments: deps.comments } : {}),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    ...(deps.githubMatches ? { githubMatches: deps.githubMatches } : {}),
    ...(deps.githubLinks ? { githubLinks: deps.githubLinks } : {}),
    ...(deps.githubComments ? { githubComments: deps.githubComments } : {}),
    ...(deps.onMatches ? { onMatches: deps.onMatches } : {}),
    log: deps.log,
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsJiraIdeaAgent,
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(agent);
      const heard = about === agent ? null : decodeAgentKey(about);
      const msg = heard?.resourceProvider === "github-issue"
        ? jiraIdeaLinkedGithubNudge(resource, heard.resourceId, reason)
        : jiraIdeaNudge(resource, reason);
      await deps.deliver(agent, resource, msg);
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? JIRA_IDEA_POLL_MS,
    onError: (e) => {
      deps.log(`[jira-idea] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
