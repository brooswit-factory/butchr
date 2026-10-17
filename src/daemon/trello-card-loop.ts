/**
 * local/ui — the daemon's `trello-card` rule loop, run beside the other rule
 * loops over the same herd. The twin of `./zendesk-ticket-loop.ts`, kept out
 * of src/daemon/index.ts so the wiring itself is testable.
 *
 * What it deliberately does NOT get from the Jira loop: label sync, the
 * abandoned/stall detectors, respawn and crash-loop comments. Every one of
 * those writes to the resource, and nothing but an agent's own comment is
 * written to a Trello card. `ownsId` scopes reconciliation to `trello-card`
 * agents, so no loop can stop another's.
 */
import type { Herd } from "../agents/herd.js";
import { trelloCardNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { TrelloCardClient } from "../resources/trello-card.js";
import type { NotifyReason } from "../resources/types.js";
import { createTrelloCardResourceType, ownsTrelloCardAgent, type TrelloCardStaffing } from "../rules/trello-card-type.js";
import type { Rule } from "../rules/rules.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Trello allows 100 requests per 10 seconds per token; a poll a minute leaves plenty of room for several rules. */
export const TRELLO_CARD_POLL_MS = 60_000;

export interface TrelloCardLoopDeps {
  /** The one-time startup staffing decision (risk ack, board and credentials, query validity). */
  staffing: TrelloCardStaffing;
  /** The live rules array, read fresh each poll so a rules reload applies (see `ZendeskTicketLoopDeps.rules`). Defaults to `staffing.rules`. */
  rules?: readonly Rule[];
  client: Pick<TrelloCardClient, "searchAll" | "lists" | "comments">;
  herd: Herd;
  /** Deliver one message to one agent (channel push and pane prompt). */
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
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

/**
 * Starts the loop. When staffing doesn't allow trello-card rules it logs why
 * (if there's anything to say) and runs with NO rules: nothing is searched or
 * spawned, but `trello-card` agents left over from an earlier run are stopped
 * rather than left running with no tools and no loop to stop them.
 */
export function startTrelloCardLoop(deps: TrelloCardLoopDeps): Stop {
  if (!deps.staffing.run && deps.staffing.reason) deps.log(`WARNING: ${deps.staffing.reason}`);
  const type = createTrelloCardResourceType({
    rules: deps.staffing.run ? (deps.rules ?? deps.staffing.rules) : [],
    search: (text) => deps.client.searchAll(text),
    lists: () => deps.client.lists(),
    comments: (ref) => deps.client.comments(ref),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsTrelloCardAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsTrelloCardAgent,
    // `about`, not `resourceKeyOf(agent)` unconditionally: a `singleton`/
    // `persistent` rule's scope entry names a different card than the query
    // agent's own key (see github-issue-loop.ts's `notify`).
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, trelloCardNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? TRELLO_CARD_POLL_MS,
    onError: (e) => {
      deps.log(`[trello-card] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
