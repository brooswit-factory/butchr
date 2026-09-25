/**
 * BUTCHR-408 — the daemon loop for butchr's own built-in managed-session
 * query. Structurally a sibling of `filesystem-loop.ts`, simplified because
 * there is exactly ONE rule (never read from `rules.json` — see
 * `builtinManagedSessionsRule`, src/rules/session-definition-type.ts), fixed
 * to `swarm` execution, so there is no `filesystemRules`-style filter step
 * and no singleton/persistent scope handling to wire up.
 */
import { readFile } from "node:fs/promises";
import type { Stop } from "@brooswit/sundry";
import type { Herd } from "../agents/herd.js";
import { filesystemNudge } from "../agents/change-nudge.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { FilesystemQuery } from "../resources/filesystem-query.js";
import { listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import { sessionDefinitionsPath, type SessionDefinitionsEnv } from "../resources/session-definition.js";
import type { NotifyReason } from "../resources/types.js";
import type { AgentRole } from "../rules/rules.js";
import { builtinManagedSessionsRule, createManagedSessionResourceType, ownsManagedSessionAgent } from "../rules/session-definition-type.js";
import { runResourceLoop } from "./loop.js";

/** Local disk reads are cheap; same cadence as the (very similar) filesystem rule loop. */
export const MANAGED_SESSIONS_POLL_MS = 15_000;

export interface ManagedSessionsLoopDeps {
  /** The well-known definitions directory. Defaults to `sessionDefinitionsPath()`; a test passes a temp dir. */
  root?: string;
  env?: SessionDefinitionsEnv;
  /** Injectable so tests use a temp dir and an explicit tick — never a sleep-and-hope. */
  list?: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  /** Injectable so tests use an in-memory map instead of real disk. */
  read?: (path: string) => Promise<string>;
  /** See `ManagedSessionResourceDeps.roles` (src/rules/session-definition-type.ts) — threaded straight through, unchanged shape. Optional; omitted, no role information is surfaced (existing behaviour unchanged). */
  roles?: Map<string, AgentRole>;
  herd: Herd;
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

/**
 * Starts the loop. Its root is read once at start (mirroring every other
 * rule's `query` being fixed once rules are loaded) — a `BUTCHR_SESSION_DEFINITIONS_DIR`
 * change takes effect on the next daemon restart, not live.
 */
export function startManagedSessionsLoop(deps: ManagedSessionsLoopDeps): Stop {
  const rule = builtinManagedSessionsRule(deps.root ?? sessionDefinitionsPath(deps.env));
  const type = createManagedSessionResourceType({
    rule,
    list: deps.list ?? listFilesystemResources,
    read: deps.read ?? ((path) => readFile(path, "utf8")),
    log: deps.log,
    ...(deps.roles ? { roles: deps.roles } : {}),
  });
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: (id) => ownsManagedSessionAgent(id, rule.id),
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
    intervalMs: deps.intervalMs ?? MANAGED_SESSIONS_POLL_MS,
    onError: (e) => {
      deps.log(`[managed-sessions] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
