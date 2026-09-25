/**
 * The daemon's `filesystem` rule loop, run beside the other rule loops over
 * the same herd. Unlike zendesk-ticket/github-issue, there is no staffing
 * gate and no credential to check: `list` reads the local disk
 * (src/resources/filesystem.ts) directly, so every enabled `filesystem` rule
 * always runs.
 *
 * Gets none of the Jira work loop's label sync or parked/abandoned/stall
 * detectors — those write Jira-work conventions no filesystem resource has.
 * `ownsId` scopes reconciliation to `filesystem` agents, so no loop can stop
 * another's.
 */
import type { Herd } from "../agents/herd.js";
import { filesystemNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { FilesystemQuery } from "../resources/filesystem-query.js";
import { listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import type { NotifyReason } from "../resources/types.js";
import { createFilesystemResourceType, ownsFilesystemAgent } from "../rules/filesystem-type.js";
import type { Rule } from "../rules/rules.js";
import type { Stop } from "@brooswit/sundry";
import { runResourceLoop } from "./loop.js";

/** Local disk reads are cheap and have no rate limit; same cadence as the Jira work rule loop. */
export const FILESYSTEM_POLL_MS = 15_000;

export interface FilesystemLoopDeps {
  /** All validated rules; only enabled `filesystem` rules run. */
  rules: readonly Rule[];
  /** Every resource one query currently matches (src/resources/filesystem.ts#listFilesystemResources). Injectable so tests use a temp dir and an explicit tick — never a sleep-and-hope. */
  list?: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
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

/** The enabled `filesystem` rules, in file order. */
export const filesystemRules = (rules: readonly Rule[]): Rule[] => rules.filter((r) => r.enabled && r.resourceProvider === "filesystem");

/**
 * Starts the loop. With no enabled `filesystem` rule it walks nothing and
 * spawns nothing, but still stops `filesystem` agents left over from an
 * earlier run (a rule since disabled or removed) — never leaves them running
 * with no loop to stop them.
 */
export function startFilesystemLoop(deps: FilesystemLoopDeps): Stop {
  const rules = filesystemRules(deps.rules);
  const type = createFilesystemResourceType({
    rules,
    list: deps.list ?? listFilesystemResources,
    log: deps.log,
    runningIds: async () => (await deps.herd.runningIssues()).filter(ownsFilesystemAgent),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: ownsFilesystemAgent,
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, filesystemNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? FILESYSTEM_POLL_MS,
    onError: (e) => {
      deps.log(`[filesystem] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
