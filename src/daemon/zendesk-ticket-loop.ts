/**
 * The daemon's `zendesk-ticket` rule loop, run beside the other rule loops
 * over the same herd. Kept out of src/daemon/index.ts so the wiring itself is
 * testable.
 *
 * What it deliberately does NOT get from the Jira loop: label sync, the
 * parked/abandoned/stall detectors, respawn and crash-loop comments. Every
 * one of those writes to the resource, and nothing but an agent's own
 * internal note may be written to a Zendesk ticket. `ownsId` scopes
 * reconciliation to `zendesk-ticket` agents, so no loop can stop another's.
 */
import type { Herd } from "../agents/herd.js";
import type { AccountLifecycleHooks } from "../agents/account-lifecycle.js";
import { zendeskTicketNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { ZendeskTicketClient } from "../resources/zendesk-ticket.js";
import type { NotifyReason } from "../resources/types.js";
import { createZendeskTicketResourceType, ownsZendeskTicketAgent, type ZendeskTicketStaffing } from "../rules/zendesk-ticket-type.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Zendesk's Search API is rate limited per account; one poll a minute leaves room for several rules and pages. */
export const ZENDESK_TICKET_POLL_MS = 60_000;

export interface ZendeskTicketLoopDeps {
  staffing: ZendeskTicketStaffing;
  client: Pick<ZendeskTicketClient, "searchAll" | "comments">;
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
}

/**
 * Starts the loop. When staffing does not allow zendesk-ticket rules it logs
 * why (if there is anything to say) and runs with NO rules: nothing is
 * searched or spawned, but `zendesk-ticket` agents left over from an earlier
 * run are stopped rather than left running with no tools and no loop to stop
 * them.
 */
export function startZendeskTicketLoop(deps: ZendeskTicketLoopDeps): Stop {
  if (!deps.staffing.run && deps.staffing.reason) deps.log(`WARNING: ${deps.staffing.reason}`);
  const type = createZendeskTicketResourceType({
    rules: deps.staffing.run ? deps.staffing.rules : [],
    search: (query) => deps.client.searchAll(query),
    comments: (ref) => deps.client.comments(ref),
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsZendeskTicketAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsZendeskTicketAgent,
    // BUTCHR-398: `about`, not `resourceKeyOf(agent)` unconditionally — see
    // github-issue-loop.ts's own `notify` comment for why (a `singleton`/
    // `persistent` rule's own scope entry names a DIFFERENT ticket than the
    // query agent's own key).
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, zendeskTicketNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    ...(deps.account ? { account: deps.account } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? ZENDESK_TICKET_POLL_MS,
    onError: (e) => {
      deps.log(`[zendesk-ticket] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
