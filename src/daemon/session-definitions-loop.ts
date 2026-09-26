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
import type { JiraIssue } from "../atlassian/types.js";
import type { AccountLifecycleHooks } from "../agents/account-lifecycle.js";
import type { Herd } from "../agents/herd.js";
import { filesystemNudge } from "../agents/change-nudge.js";
import { realPathExists, wireManagedSessionArchiveRelease } from "../agents/managed-session-account-release.js";
import { resourceKeyOf } from "../agents/workspace.js";
import type { LinkedEventingDeps } from "../jira-watch/linked-eventing.js";
import type { FilesystemQuery } from "../resources/filesystem-query.js";
import { listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import { sessionDefinitionsPath, type SessionDefinitionsEnv } from "../resources/session-definition.js";
import type { NotifyReason } from "../resources/types.js";
import type { AccountPolicy, AgentRole } from "../rules/rules.js";
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
  /** See `ManagedSessionResourceDeps.accountPolicies` (src/rules/session-definition-type.ts) — threaded straight through, unchanged shape. Optional; omitted, no per-definition account policy is surfaced (existing behaviour unchanged). */
  accountPolicies?: Map<string, AccountPolicy>;
  /** See `ManagedSessionResourceDeps.lizardModes` (src/rules/session-definition-type.ts) — threaded straight through, unchanged shape. Optional; omitted, no lizard-mode information is surfaced (existing behaviour unchanged). */
  lizardModes?: Map<string, boolean>;
  /**
   * BUTCHR-460 — the SAME shared `AccountLifecycleHooks` instance every
   * other rule loop is wired against (src/daemon/index.ts), wrapped here
   * (see `../agents/managed-session-account-release.ts`) so a managed-
   * session agent's release is reported as `"archive"`, not the generic
   * `"stop"`, whenever this loop can positively confirm the stop was one.
   * Optional; omitted, no account lifecycle runs for managed-session agents
   * at all (today's behaviour — see that module's own top comment for why
   * this is the ONE place that distinction can be made).
   */
  account?: AccountLifecycleHooks;
  /** Only used to build the default `exists` check behind `account`'s archive-detection wrapper; overridable so a test never touches real disk. Defaults to `../agents/managed-session-account-release.js`'s `realPathExists`. */
  exists?: (path: string) => Promise<boolean>;
  herd: Herd;
  deliver: (agent: string, resource: string, message: string) => Promise<void>;
  admission?: (candidates: readonly string[], stopping: readonly string[]) => Promise<readonly string[]>;
  onAdmitted?: (succeeded: readonly string[]) => void;
  reserveAdmission?: (ids: readonly string[]) => void;
  releaseAdmission?: (ids: readonly string[]) => Promise<void>;
  checkResidency?: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
  /**
   * FACTORY-47: same seam as `ReconcileOptions.checkCrashLoop`/
   * `GenericLoopDeps.checkCrashLoop` (src/daemon/loop.ts) — audible-only
   * detection of a managed-session agent that keeps dying and being spawned
   * again (a startup crash, an MCP config that fails to load, a session-
   * limit refusal that never clears, ...) with nothing else in this loop
   * recording why. Threaded straight through to `runResourceLoop` below.
   * Optional; omitted, no crash-loop detection runs for managed sessions —
   * the gap this ticket reports.
   */
  checkCrashLoop?: (spawning: readonly string[], desired: readonly string[]) => Promise<void>;
  log: (line: string) => void;
  intervalMs?: number;
  /** Each completed poll, for /health. */
  onPollSuccess?: () => void;
  /** Each failed poll (after it is logged), for /health. */
  onError?: (error: unknown) => void;
  /**
   * FACTORY-53/FACTORY-71 — linked-change eventing for a managed session
   * that opts in via its own `linkedEventingProjects` field. All five are
   * threaded straight through to `ManagedSessionResourceDeps`
   * (src/rules/session-definition-type.ts) unchanged; see that interface's
   * own doc comments for what each does. `searchIssues` and `notify` must
   * BOTH be present for a linked-eventing tick to ever run; any subset
   * omitted, existing behaviour (no linked-eventing at all) is unchanged.
   */
  searchIssues?: (jql: string) => Promise<JiraIssue[]>;
  notify?: (agentKey: string, about: string, reason: NotifyReason) => void | Promise<void>;
  comments?: LinkedEventingDeps["comments"];
  linkStore?: LinkedEventingDeps["linkStore"];
  isFrozen?: (id: string) => Promise<boolean>;
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
    ...(deps.accountPolicies ? { accountPolicies: deps.accountPolicies } : {}),
    ...(deps.searchIssues ? { searchIssues: deps.searchIssues } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
    ...(deps.comments ? { comments: deps.comments } : {}),
    ...(deps.linkStore ? { linkStore: deps.linkStore } : {}),
    ...(deps.isFrozen ? { isFrozen: deps.isFrozen } : {}),
    ...(deps.lizardModes ? { lizardModes: deps.lizardModes } : {}),
  });
  const account = deps.account
    ? wireManagedSessionArchiveRelease(deps.account, { exists: deps.exists ?? realPathExists, ...(deps.env ? { env: deps.env } : {}), ruleId: rule.id })
    : undefined;
  return runResourceLoop(type, {
    herd: deps.herd,
    ownsId: (id) => ownsManagedSessionAgent(id, rule.id),
    notify: async (agent: string, about: string, reason?: NotifyReason) => {
      const resource = resourceKeyOf(about === agent ? agent : about);
      await deps.deliver(agent, resource, filesystemNudge(resource, reason));
    },
    onRespawn: (agent, reason) => deps.log(`[reconcile] ${agent} respawned: ${reason}`),
    ...(account ? { account } : {}),
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.onAdmitted ? { onAdmitted: deps.onAdmitted } : {}),
    ...(deps.reserveAdmission ? { reserveAdmission: deps.reserveAdmission } : {}),
    ...(deps.releaseAdmission ? { releaseAdmission: deps.releaseAdmission } : {}),
    ...(deps.checkResidency ? { checkResidency: deps.checkResidency } : {}),
    ...(deps.checkCrashLoop ? { checkCrashLoop: deps.checkCrashLoop } : {}),
    log: deps.log,
    intervalMs: deps.intervalMs ?? MANAGED_SESSIONS_POLL_MS,
    onError: (e) => {
      deps.log(`[managed-sessions] loop error: ${(e as Error)?.message ?? e}`);
      deps.onError?.(e);
    },
    ...(deps.onPollSuccess ? { onPollSuccess: deps.onPollSuccess } : {}),
  });
}
