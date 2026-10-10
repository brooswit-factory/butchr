/**
 * FACTORY-998 (story FACTORY-992): the daemon's `confluence-page` rule
 * loop, run beside the other rule loops over the same herd. Like
 * `filesystem`, there is no separate staffing gate here: this daemon never
 * reaches the real rule loops at all without a fully-configured Atlassian
 * site/email/token (`src/daemon/index.ts`'s own setup-mode gate, checked
 * before any loop below starts), so the SAME `AtlassianOps` instance every
 * other Confluence/Jira read path already uses is always available here
 * too — no new credential, no new staffing predicate.
 *
 * Gets none of the Jira work loop's label sync or parked/abandoned/stall
 * detectors — those write Jira-work conventions no Confluence page has.
 * `ownsId` scopes reconciliation to `confluence-page` agents, so no loop
 * can stop another's.
 */
import type { Herd } from "../agents/herd.js";
import { confluencePageNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { NotifyReason } from "../resources/types.js";
import { createConfluencePageResourceType, ownsConfluencePageAgent, type ConfluencePageResourceDeps } from "../rules/confluence-page-type.js";
import type { Rule } from "../rules/rules.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Same cadence `src/resources/confluence-page-event-path.md` already documents for the standalone-page event path, and the same tier `src/daemon/index.ts`'s own Confluence-link poller runs on. */
export const CONFLUENCE_PAGE_POLL_MS = 15_000;

export interface ConfluencePageLoopDeps {
  /** All validated rules; only enabled `confluence-page` rules run. */
  rules: readonly Rule[];
  getChildPages: ConfluencePageResourceDeps["getChildPages"];
  getPageVersions: ConfluencePageResourceDeps["getPageVersions"];
  getPageComments: ConfluencePageResourceDeps["getPageComments"];
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  reserveAdmission?: (ids: readonly string[]) => void;
  releaseAdmission?: (ids: readonly string[]) => Promise<void>;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  log: (line: string) => void;
  intervalMs?: number;
  /** Each completed poll, for /health. */
  onPollSuccess?: () => void;
  /** Each failed poll (after it is logged), for /health. */
  onError?: (error: unknown) => void;
}

/** The enabled `confluence-page` rules, in file order. */
export const confluencePageRules = (rules: readonly Rule[]): Rule[] => rules.filter((r) => r.enabled && r.resourceProvider === "confluence-page");

/**
 * Starts the loop. With no enabled `confluence-page` rule it enumerates
 * nothing and spawns nothing, but still stops `confluence-page` agents left
 * over from an earlier run (a rule since disabled or removed) — never
 * leaves them running with no loop to stop them.
 */
export function startConfluencePageLoop(deps: ConfluencePageLoopDeps): Stop {
  // FACTORY-657-style discipline (filesystem-loop.ts's own precedent): pass
  // `deps.rules` straight through, never pre-filtered into a local —
  // `createConfluencePageResourceType`'s own `discovery.search`
  // (src/rules/confluence-page-type.ts) already re-derives the enabled
  // `confluence-page` subset on every poll from whatever it reads here, so
  // filtering it ourselves, once, at loop-start would freeze a snapshot a
  // rules reload (`RulesHolder.setRules`) could never update.
  const type = createConfluencePageResourceType({
    rules: deps.rules,
    getChildPages: deps.getChildPages,
    getPageVersions: deps.getPageVersions,
    getPageComments: deps.getPageComments,
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsConfluencePageAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsConfluencePageAgent,
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, confluencePageNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? CONFLUENCE_PAGE_POLL_MS,
    onError: (e) => {
      deps.log(`[confluence-page] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
