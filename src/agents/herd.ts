import { instanceFreezeStore, watchInstanceFreeze } from '@brooswit/drovr-events';
import { createHash } from "node:crypto";
import { ManagedHerdrLifecycle, classifyProviderQuotaText, managedAgentProviderOfProcess, ProviderAvailabilityRegistry, processProviderAvailability, startManagedAgent, HerdrError, type ManagedAgentProvider, type DrovrClient, type results } from "@brooswit/drovr";
import { prepareFactoryWorkspace } from "../mcp/registration.js";
import { buildWorkspace, workspaceExternalMcp, workspaceMcpServers, workspacePermissionMode, workspaceStrictMcpConfig, workspaceModel, workspaceEffort, workspaceSessionId, discoverClaudeSessionId, persistDiscoveredSessionId, invalidatePersistedSessionId, claudeTranscriptExists, agentIdOfWorkspacePath, ensureWorkspaceDir, workspaceDirFor, workspaceRoot, workspaceIsolation, type SpawnSpec } from "./workspace.js";
import { decodeAgentKey } from "../rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../rules/session-definition-type.js";
import { baseDisplayLabel, FULL_AGENT_KEY_METADATA_FIELD, METADATA_SOURCE, resolveDisplayLabels } from "../rules/display-label.js";
import { agentLaunchConfig, agentStartParams, kickoffFor, spawnArgs, checkArgv, providerOrder, type AgentConfig } from "./argv.js";
import type { AgentEffort, McpServerBinding } from "../rules/rules.js";
import type { SessionLimitRefusal } from "./session-limit.js";
import { strandedCandidates, type StrandedCandidate } from "./reap.js";
import { panesFor, groupOwnedPanes, aggregateVerdict, type ResidencyVerdict } from "./residency-census.js";
export type { SpawnSpec } from "./workspace.js";
export type { StrandedCandidate } from "./reap.js";
export type { ResidencyVerdict } from "./residency-census.js";


/**
 * What nudge() actually accomplished — plain "delivered: true" (KAN-829) hid
 * a prompt that landed on a session-limit refusal, so `[notify] … prompt
 * delivered` was logged for a prompt that was, in fact, refused. `delivered`
 * still means "the send call itself succeeded" (agent.prompt did not throw —
 * distinct from `false`, where no agent was running or the pane rejected the
 * send outright, e.g. blocked on a dialog); `refusal` is set in addition,
 * after the verify wait, when the pane shows the session's refusal rather
 * than a started turn — the caller (daemon/index.ts) uses this to log
 * `refused (session limit, resets …)` instead of a bare "delivered", so the
 * operator can `grep` the journal for it.
 */
export interface NudgeResult {
  delivered: boolean;
  refusal?: SessionLimitRefusal;
}

/** A running agent found to be stale: its process argv lacks butchr's spawn flags. */
export interface StaleAgent {
  issue: string;
  /** Why it's stale — a checkArgv() reason string, e.g. "argv lacks --permission-mode bypassPermissions". */
  reason: string;
  /** The offending process's real argv, for the log line and Jira notice. */
  observedArgv: string[];
  /**
   * FACTORY-314 — `true` ONLY for the narrow case this ticket adds a second
   * respawn path for: a Claude agent whose SOLE staleness is the
   * `resolvedAgentOf` model/effort comparison below (never a
   * `checkArgv`/`checkManagedAgentArgv` failure, and never a non-Claude
   * provider — see the two push sites in `staleIssues()` for exactly which
   * one sets this). The reconcile loop (`src/daemon/loop.ts`) reads this to
   * choose `herd.resumeInPlace()` over today's `herd.stop()`+`herd.spawn()`;
   * every OTHER stale reason leaves this `false`/absent and keeps today's
   * fresh-restart behaviour completely unchanged.
   */
  resumable?: boolean;
}

/** What the reconcile loop needs from herdr. Abstracted so it fakes cleanly in tests. */
export interface Herd {
  frozen?(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** Issues that currently have a butchr-managed agent running. */
  runningIssues(): Promise<string[]>;
  /**
   * Running agents whose claude process was found, but its argv lacks
   * butchr's spawn flags — e.g. a pane herdr restored as a bare
   * `claude --resume <id>` after a server restart. Resolved from the pane's
   * OWN foreground process (herdr's `pane.process_info`) — never by scanning
   * /proc for a process sharing the cwd, which a stray process at that cwd
   * could confuse (see CHANGELOG). An agent whose process can't be found at
   * all is NOT stale (unknown ≠ stale).
   */
  staleIssues(): Promise<StaleAgent[]>;
  /**
   * Start an agent for an issue (idempotent — a no-op if one is already
   * running). `origin` — see `SpawnOrigin` — names which reconcile loop is
   * calling; optional and defaults to `"spawn"` (every caller before
   * BUTCHR-334, and the ordinary plan-spawn loop today), so no existing
   * caller needs to change.
   */
  spawn(spec: SpawnSpec, origin?: SpawnOrigin): Promise<void>;
  /** Observe a desired worker's quota state before reconciliation decides to spawn. */
  recoverQuota?(spec: SpawnSpec): Promise<"not-refused" | "recovered" | "waiting">;
  /** Shut off the agent for an issue (idempotent). */
  stop(issue: string): Promise<void>;
  /** The current pane id of an issue's agent, freshly resolved, or null if not running. */
  paneFor(issue: string): Promise<string | null>;
  /**
   * Deliver `text` to the issue's agent as a prompt — this STARTS a turn on an
   * idle agent (a channel push renders mid-turn but cannot wake one). Queues on
   * a busy agent. `delivered: false` if no agent is running or the pane
   * refused the send outright (blocked); `refusal` set if the send succeeded
   * but the pane shows a session-limit refusal rather than a started turn.
   */
  nudge(issue: string, text: string): Promise<NudgeResult>;
  /**
   * The provider actually running an issue's agent right now, resolved from
   * its pane's OWN foreground process (the same source `staleIssues()`
   * already trusts) — never from static config, which under ordered
   * provider fallback (BUTCHR-238/docs/agent-providers.md) can differ from
   * what is actually running. `null` when no agent is running, or its
   * provider can't be determined from the pane (a starting shell, a process
   * that already exited, a pane blocked on a dialog). Optional so no
   * existing `Herd` fake needs updating (BUTCHR-413's Codex channel relay is
   * its only caller so far). See `HerdrHerd`'s implementation for reuse with
   * `staleIssues()`'s identical lookup.
   */
  providerOf?(issue: string): Promise<ManagedAgentProvider | null>;
  /**
   * FACTORY-314 — relaunch a `StaleAgent.resumable` issue's Claude session on
   * the SAME pane with `--resume <persisted-session-id>` plus the new
   * model/effort and the full flag set, instead of `stop()`+`spawn()`
   * (which discards the conversation). Deliberately NOT `ManagedHerdrLifecycle`-based:
   * that class always mints a brand-new pane/workspace for ANY
   * "continue after change" request (verified against the pinned drovr
   * 0.15.1 source — see the ticket's own comment trail), the wrong tool for
   * relaunching in place.
   *
   * FIVE outcomes, each with a DIFFERENT caller response (`reconcileNow`,
   * src/daemon/loop.ts):
   * - `"resumed"`: success — conversation preserved, SAME session id, and
   *   CONFIRMED alive (see `"failed"` below for the case this rules out).
   *   Comment: "session preserved", never "re-read your ticket".
   * - `"deferred"`: the agent is mid-turn right now — never interrupts a
   *   turn. The caller retries a later poll; no stop, no spawn, no comment
   *   per-poll (a bounded consecutive-count notice only, `ResumeDeferGuard`).
   * - `"stuck"`: EITHER `/exit` was sent but the pane never returned to a
   *   shell prompt (a dialog, a hang) — do NOT relaunch onto it, do NOT kill
   *   it — OR (MEASURED live) the pane DID return to a shell but herdr
   *   rejects the relaunch with `agent_name_taken`: the old process can
   *   still hold the pane's agent name for a moment even after it stops
   *   being the reported foreground process. Same non-destructive retry as
   *   `"deferred"` either way, distinguished only in the eventual notice's
   *   wording (a human likely needs to look, not just wait).
   * - `"unresumable"`: resuming isn't possible for a reason unrelated to
   *   timing (no persisted session id — a pre-FACTORY-314 workspace — or the
   *   running provider isn't Claude, or the agent disappeared entirely). The
   *   caller falls back to today's stop-then-fresh-spawn, with a comment
   *   that says plainly the session was lost and why ("session id could not
   *   be determined").
   * - `"failed"`: the relaunch was ACCEPTED by herdr but Claude did not stay
   *   up (an unavailable model, or any other immediate exit) — caught by a
   *   brief post-launch liveness check, since herdr accepting a launch only
   *   means the process started. The model/effort files are deliberately
   *   left UNCHANGED (persisted only after a CONFIRMED-alive relaunch — see
   *   this method's own body) so a failed attempt stays detectable rather
   *   than looking "already matching" on the next poll. The caller falls
   *   back to today's stop-then-fresh-spawn, with a comment that says
   *   plainly the resume failed and why.
   * Never throws for any of the five; only a genuine herdr/RPC failure does.
   * Optional so no existing `Herd` fake needs updating.
   */
  resumeInPlace?(spec: SpawnSpec): Promise<"resumed" | "deferred" | "stuck" | "unresumable" | "failed">;
}

export interface ManagedHerdAgent {
  issue: string;
  pane: string;
  cwd: string;
  status: string;
}

const AGENT_PREFIX = "butchr-";
/** Hex characters of the key's SHA-256 in a name: `butchr-` plus 24 is 31, under Herdr's 32-character limit. */
const NAME_HASH_LEN = 24;
/**
 * Display name only (identity comes from the workspace cwd). Herdr accepts
 * only lowercase `[a-z0-9_-]` names of at most 32 characters, while agent keys
 * are arbitrarily long, mixed-case, and full of `:`, `/` and `#`. So the name
 * is a fixed-length hash of the exact key: one key always gets the same name,
 * distinct keys get distinct names, and no key can make it invalid.
 */
const nameFor = (key: string) => AGENT_PREFIX + createHash("sha256").update(key).digest("hex").slice(0, NAME_HASH_LEN);

/**
 * How long nudge() waits after delivering a prompt before checking whether a
 * turn actually started, vs. the prompt merely landing in an unsubmitted
 * composer (KAN-691 sat 2.5h on exactly that). 8s is long enough for Claude
 * Code to move off "idle" once it accepts input.
 */
const NUDGE_VERIFY_MS = 8_000;

/** Retry interval after Herdr confirms a shell-busy rejection. */
export const PANE_READY_WAIT_MS = 200;

/** Deadline for confirmed shell-busy retries; native launch timeouts remain Herdr-owned. */
export const PANE_READINESS_TIMEOUT_MS = 5_000;

/** @deprecated Historical reproduction-script budget; runtime uses Drovr's deadline. */
export const PANE_BUSY_MAX_RETRIES = 4;

/**
 * FACTORY-314 — how long `resumeInPlace()` waits for a pane it just asked to
 * `/exit` to actually show a shell in its foreground, polling every
 * `RESUME_EXIT_POLL_MS`. Bounded deliberately: a pane that never returns to
 * a shell (stuck on a confirmation, a hung process) must never be relaunched
 * onto — see that method's own doc comment for why the caller aborts rather
 * than force-killing anything when this deadline passes.
 */
export const RESUME_EXIT_TIMEOUT_MS = 10_000;
export const RESUME_EXIT_POLL_MS = 250;

/**
 * FACTORY-314 (FACTORY-312 review, 26137 point 2) — how long `resumeInPlace()`
 * waits after `startManagedAgent` returns before confirming Claude actually
 * stayed up. Herdr accepting the launch only means the process STARTED; an
 * unavailable model or similar exits almost immediately (measured: exit 1
 * within a couple seconds) and this is the only thing that catches it.
 */
export const RESUME_LAUNCH_VERIFY_MS = 3_000;

/**
 * FACTORY-314 (PR #513 review fix) — how many times `startProviders()`
 * retries `discoverClaudeSessionId` after a fresh Claude launch (waiting
 * `SESSION_DISCOVERY_POLL_MS` between attempts) before giving up and logging
 * a WARNING. MEASURED necessary live: a single check immediately after
 * `ManagedHerdrLifecycle.start()` returns can race Claude's own
 * transcript-file creation (see `startProviders`'s own doc comment on this
 * exact seam) and find nothing even though the launch is genuinely healthy.
 *
 * ITERATION-COUNTED, deliberately NOT a `this.monotonicNow()` deadline like
 * `resumeInPlace()`'s own exit-wait loop: this one is reached by EVERY
 * successful Claude spawn, including every existing test that fakes `wait`
 * as instant (`instant = () => Promise.resolve()`) without also faking
 * `monotonicNow` in lockstep. A wall-clock deadline compared against REAL
 * `performance.now()` would not budge while `wait` resolves instantly,
 * turning a discovery that legitimately never finds anything (any test with
 * no real transcript on disk) into a real ~15s stall PER SPAWN — measured
 * directly: it hung this ticket's own test suite. Counting attempts instead
 * ties the bound to `wait()` itself, so a faked instant `wait` makes the
 * whole retry loop resolve in microtasks, exactly like every other bounded
 * loop in this file that is exercised under `instant`.
 */
export const SESSION_DISCOVERY_ATTEMPTS = 15;
export const SESSION_DISCOVERY_POLL_MS = 1_000;

/**
 * BUTCHR-320: the single tag every spawn-attempt outcome line is emitted
 * under, whatever the outcome — success, failure, or the no-op early return
 * (see `spawn()`'s own doc comment for why all three share it). A window's
 * spawn attempt count is `count of lines under this tag`, with no
 * reconstruction from any other signal. `attempts = successes + failures +
 * noops` holds on its own, as a count of lines under this tag — that bare
 * rule is unaffected by anything below.
 *
 * BUTCHR-334 — THE CROSS-INSTRUMENT RULE, WITH ITS RESPAWN TERM: comparing
 * this tag's count against `[admission2]`'s own `admitted=` field (BUTCHR-320
 * falsifier 2) is a DIFFERENT, narrower claim than the bare rule above, and
 * "attempts == admitted" is FALSE on any poll containing a respawn.
 * `herd.spawn()` is called from TWO places in `reconcileNow`
 * (src/daemon/loop.ts): the ordinary plan-spawn loop, whose candidates ARE
 * admission-controlled, and the respawn loop, which is NOT —
 * `ReconcileOptions.admission`'s own doc comment says so explicitly:
 * "`plan.stop`/`plan.respawn` are never touched: only the spawn candidate
 * list is admission-controlled." The TRUE rule, for one poll:
 *
 *   attempts under [spawn]  ==  admitted from [admission2]'s `admitted=`
 *                              +  respawn attempts this same poll
 *
 * Every outcome line under this tag now carries `origin=spawn` or
 * `origin=respawn` (the `SpawnOrigin` param `spawn()` takes below) so BOTH
 * terms are countable from the journal alone — `respawn attempts = count of
 * [spawn] lines with origin=respawn`, whatever their outcome, INCLUDING a
 * FAILED respawn attempt: before this, a failed respawn's only OTHER trace
 * (the `[reconcile] <KEY> respawned:` line, loop.ts) is written only on
 * SUCCESS, so a failed respawn was indistinguishable, by tag, from a failed
 * plan spawn. `origin=` closes that gap without touching that line at all.
 * This is a FORMAT CHANGE to every line under this tag (every document that
 * quotes it needs updating to match) — never a behaviour change: `spec` and
 * the three outcomes are exactly as before, `origin` only labels which
 * caller produced the attempt.
 *
 * REVIEW FIX (round 1): `origin=` sits BEFORE the free-text error message on
 * the failure line — `failed origin=<x> — <message>`, never `failed — <message>
 * origin=<x>` — because `<message>` is SERVER-SUPPLIED text (`HerdrError`'s
 * own message comes from `body.message` off the wire) with nothing excluding
 * a newline in it. A structured field placed AFTER unbounded free text can
 * end up on a different journal line than its own tag the moment that text
 * contains one, silently undercounting `respawn attempts = count of [spawn]
 * lines with origin=respawn` in exactly the failing-and-looks-like-a-broken-
 * instrument shape this whole epic exists to close. The success/noop lines
 * don't have this hazard (`paneId` and the literal noop text are both
 * bounded), so only the failure line's field order matters here.
 */
export const SPAWN_TAG = "[spawn]";

/**
 * FACTORY-75 (PR #473 review fix) — `staleIssues()`'s own argv fallback for
 * `--model`/`--effort`, used ONLY when `workspaceModel`/`workspaceEffort`
 * (src/agents/workspace.ts) find no persisted file: a workspace spawned by
 * a build before this ticket never wrote one, so this recovers what the
 * ALREADY-RUNNING process was actually launched with directly from its own
 * argv, rather than treating "no persisted file" as "no model/effort at
 * all" — see `staleIssues()`'s own doc comment on this exact seam for the
 * mass-restart-on-deploy bug this closes. Same `argv.indexOf(flag)` shape
 * Drovr's own internal (unexported) `flagValue` uses.
 */
const argvFlagValue = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

/**
 * BUTCHR-334: which reconcile loop produced a given `spawn()` attempt — see
 * `SPAWN_TAG`'s own doc comment for the cross-instrument rule this exists to
 * close. `spawn()` itself cannot know this (both loops call the same
 * method); the caller does, so it is threaded in as a parameter rather than
 * inferred. Defaults to `"spawn"` — see `Herd.spawn`'s own doc comment.
 */
export type SpawnOrigin = "spawn" | "respawn";

/** Herd backed by a live herdr, over the typed SDK. */
export class HerdrHerd implements Herd {
  private readonly freezeWatches = new Map<string, ReturnType<typeof watchInstanceFreeze>>();
  async frozen(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const frozen = new Set<string>();
    for(const id of ids) { try { if((await instanceFreezeStore.read(`butchr:${id}`)).frozen) frozen.add(id); }
      catch(e) { frozen.add(id); this.log?.(`Freeze state unreadable for ${id}: ${String(e)}`); } }
    return frozen;
  }
  private readonly lifecycles = new Map<string, ManagedHerdrLifecycle>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly refused = new Map<string, { pane: string; provider: ManagedAgentProvider; refusal: SessionLimitRefusal }>();

  constructor(
    private readonly herdr: DrovrClient,
    /** Where the daemon serves its MCP endpoint, so spawned agents can connect back. */
    private readonly mcpUrl: string,
    /** Injectable wait, for tests. */
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /**
     * BUTCHR-320: emits exactly one `SPAWN_TAG` outcome line per `spawn()`
     * call — see that method's own doc comment. Optional, following this
     * codebase's existing `log?: (line: string) => void` convention (e.g.
     * `AdmissionControllerDeps`, `ReconcileFailureDetectorDeps`); omitted,
     * spawn attempts are simply never logged (every caller/test before this
     * ticket).
     */
    private readonly log?: (line: string) => void,
    private readonly agent: AgentConfig = { provider: "claude" },
    private readonly availability: ProviderAvailabilityRegistry = processProviderAvailability,
    private readonly prepareWorkspace: (options: { provider: ManagedAgentProvider; cwd: string; unattended: true }) => unknown | Promise<unknown> = prepareFactoryWorkspace,
    /** Monotonic readiness clock; paired with the injected wait in tests. */
    private readonly monotonicNow: () => number = () => performance.now(),
    /**
     * BUTCHR-411 — the design decision the ticket calls out by name: how
     * `staleIssues()` sees a rule's MCP server bindings without HerdrHerd
     * itself holding any rule state (it is one flat instance shared by every
     * rule/provider — see src/daemon/index.ts). The caller resolves an
     * issue id to its rule's current `mcpServers` (or `undefined`); this
     * mirrors `roleOfAgent` in src/daemon/index.ts, the same
     * decode-then-look-up-by-ruleId shape that field already uses for a
     * different rule-level property. Optional and defaulting to "no
     * bindings for anyone" is exactly what keeps a rule that never opts into
     * `mcpServers` producing byte-identical expected argv to before this
     * ticket — the deploy-day fleet-wide-respawn hazard the ticket's own
     * survey flagged stays closed.
     */
    private readonly mcpBindingsOf?: (issue: string) => readonly McpServerBinding[] | undefined,
    /**
     * BUTCHR-413 — same shape and same reason as `mcpBindingsOf` immediately
     * above, one field over: this issue's own non-secret account-identifying
     * name for `McpServerBinding.accountHeader` (`spec.rocketchatAccount`, see
     * that field's own doc comment, src/agents/workspace.ts), or `undefined`
     * for none (an `account: "none"` rule, or no Rocket.Chat configured at
     * all). Called from BOTH `spawnExclusive` (augments the real spec before
     * `buildWorkspace`/`agentLaunchConfig`) and `staleIssues()` (augments the
     * reconstructed comparison spec) — the SAME callback both times, so a
     * value that is deterministic in its caller (as `rcUsernameFor(issue)`
     * is, src/accounts/identity.ts) can never drift between what an agent
     * was actually launched with and what a later poll expects, with no
     * persistence required. Optional and defaulting to "no account name for
     * anyone" keeps a daemon with no Rocket.Chat configured, or a rule with
     * no `accountHeader` binding, at byte-identical expected argv to before
     * this field existed.
     */
    private readonly accountNameOf?: (issue: string) => string | undefined,
    /**
     * FACTORY-75 — this issue's CURRENTLY resolved `(model, effort)` pair
     * for the given provider, from the `modelPower`/`effort` two-axis
     * mechanism (src/resources/power-scale.ts): a managed-session
     * definition's own field, or a rule's `agentPreferences` entry
     * (already pre-resolved at `loadRules()` time — see `AgentPreference`'s
     * own doc comment, src/rules/rules.ts, for why nothing downstream of
     * that needed to change). `undefined` for anything this daemon cannot
     * resolve (a legacy/bare-issue id, a rule/definition since removed, or
     * one that sets neither `model`/`modelPower` nor `effort`/`effortPower`
     * for this provider) — `staleIssues()` below then skips the
     * comparison entirely, the same fail-safe "nothing to compare, so
     * nothing is stale" shape `mcpBindingsOf`'s own absence already has.
     * Called ONLY from `staleIssues()`, never from `spawn()` — a real
     * launch already gets its resolved agent straight from `spec.agents`
     * (`specForSessionDefinition`/`rule.agentPreferences`), so this seam
     * exists purely for the comparison side, unlike `mcpBindingsOf`/
     * `accountNameOf` above (which augment a real spawn too).
     */
    private readonly resolvedAgentOf?: (issue: string, provider: ManagedAgentProvider) => { model?: string; effort?: AgentEffort } | undefined,
  ) {}

  private lifecycle(issue: string): ManagedHerdrLifecycle {
    let lifecycle = this.lifecycles.get(issue);
    if (!lifecycle) {
      // FACTORY-118: `ensureWorkspaceDir`, not a bare `workspaceDirFor` —
      // claims (creates + stamps) the directory synchronously, right here,
      // the FIRST time any code path references this issue's lifecycle
      // (cached in `this.lifecycles` from then on). That is what closes the
      // two-different-colliding-short-names race for the spawn path
      // specifically: `startProviders` (below) calls `this.lifecycle(spec.key)`
      // well before its own `buildWorkspace` call, so without this, a
      // second colliding key's spawn interleaving in between could claim
      // the bare short name first, leaving THIS key's cached `cwd` pointing
      // at a directory a later `workspaceDirFor` recomputation would no
      // longer agree is free. See `ensureWorkspaceDir`'s own doc comment
      // (src/agents/workspace.ts) for why this is race-free without a lock.
      lifecycle = new ManagedHerdrLifecycle({
        client: this.herdr, cwd: ensureWorkspaceDir(issue),
        availability: this.availability, wait: this.wait,
        startOptions: {
          readinessTimeoutMs: PANE_READINESS_TIMEOUT_MS, retryIntervalMs: PANE_READY_WAIT_MS,
          now: this.monotonicNow, wait: this.wait,
        },
      });
      this.lifecycles.set(issue, lifecycle);
    }
    return lifecycle;
  }

  private async exclusive<T>(issue: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(issue) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    this.operations.set(issue, pending);
    try { return await pending; }
    finally { if (this.operations.get(issue) === pending) this.operations.delete(issue); }
  }

  quotaBlocked(issue: string): boolean { return this.refused.has(issue); }

  /** Whether any agent working `resource` (a Jira key) is quota-blocked — the label/stall layer thinks in tickets, the herd in agents. */
  resourceQuotaBlocked(resource: string): boolean {
    for (const id of this.refused.keys()) if (id === resource || decodeAgentKey(id)?.resourceId === resource) return true;
    return false;
  }

  /**
   * Which providers' panes this herd observes for quota. Codex always: no
   * other watcher recognises its usage limit, and a Codex worker at its limit
   * otherwise sits idle on its fallback model forever. Claude only with an
   * ordered-provider configuration; otherwise the legacy session-limit
   * watcher owns Claude recovery (see watchSessionLimits' skipRecovery).
   */
  private observesQuota(provider: string | null | undefined): provider is "claude" | "codex" {
    if (provider === "codex") return true;
    return provider === "claude" && !!(this.agent.providers || this.agent.roleProviders);
  }

  async recoverQuota(spec: SpawnSpec): Promise<"not-refused" | "recovered" | "waiting"> {
    const ordered = !!(this.agent.providers || this.agent.roleProviders);
    // Without an ordered configuration, only a Codex worker is ours to
    // observe; a Claude-only configuration is left exactly as the legacy
    // watcher has it, without even a Herdr read.
    if (!ordered && this.agent.provider !== "codex" && !spec.agents?.some(p => p.harness === "codex")) return "not-refused";
    return this.exclusive(spec.key, async () => {
      let current: results.AgentInfo | undefined;
      try { current = await this.lifecycle(spec.key).resolveCurrent(); }
      catch { return "not-refused"; }
      if (!ordered && current?.agent !== "codex") return "not-refused";
      if (!current) { this.refused.delete(spec.key); return "not-refused"; }
      const observed = this.observesQuota(current.agent);
      if (current.pane_id !== this.refused.get(spec.key)?.pane || !observed || current.agent_status === "working") {
        this.refused.delete(spec.key);
      }
      if (!observed || (current.agent_status !== "idle" && current.agent_status !== "done")) return "not-refused";
      const refusal = this.observeQuota(spec.key, current, await this.readPane(current.pane_id));
      if (!refusal) return "not-refused";
      // Replacement re-runs selection from the TOP of the priority list:
      // a Codex worker at its limit goes back to Claude when Claude is
      // available; a Claude worker at its limit goes on to Codex.
      const result = await this.startProviders(spec, current.pane_id);
      if (result.status === "success") this.log?.(`[provider-fallback] ${spec.key} recovered provider=${result.account.provider} pane=${result.value}`);
      return result.status === "success" ? "recovered" : "waiting";
    });
  }

  private observeQuota(issue: string, current: results.AgentInfo, text: string): SessionLimitRefusal | null {
    // Only Drovr's measured classifiers (Claude's session/weekly limit,
    // Codex's usage-limit notice) establish pane quota. No inferred AGY
    // banners or launch-error strings enter availability.
    if (current.agent !== "claude" && current.agent !== "codex") return null;
    if (current.agent_status !== "idle" && current.agent_status !== "done") return null;
    const provider = current.agent as "claude" | "codex";
    const classified = classifyProviderQuotaText(provider, text, new Date());
    if (classified.kind !== "recognised") { this.refused.delete(issue); return null; }
    const refusal = { resetsAt: classified.resetsAt, raw: classified.raw };
    const previous = this.refused.get(issue);
    // Pin the original reset for this refusal incarnation, otherwise a
    // clock-only banner rolls into tomorrow as soon as its reset passes.
    if (previous?.pane === current.pane_id && previous.refusal.raw === refusal.raw) return previous.refusal;
    const account = { provider, accountId: "default" } as const;
    const outcome = this.availability.observePane(account, current.agent_status, text);
    if (outcome.kind !== "recognised") return null;
    const confirmed = { resetsAt: outcome.resetsAt, raw: outcome.raw };
    this.refused.set(issue, { pane: current.pane_id, provider: account.provider, refusal: confirmed });
    if (this.agent.providers || this.agent.roleProviders || provider === "codex") {
      this.log?.(`[provider-fallback] ${issue} provider=${account.provider} quota-blocked resetsAt=${confirmed.resetsAt ?? "unknown"}`);
    }
    return confirmed;
  }

  private async byIssue(): Promise<Map<string, { pane: string; cwd: string; status: string }>> {
    const { agents } = await this.herdr.agent.list();
    const map = new Map<string, { pane: string; cwd: string; status: string }>();
    const ambiguous = new Set<string>();
    for (const a of agents) {
      const cwd = a.cwd ?? null;
      const issue = agentIdOfWorkspacePath(cwd);
      if (!cwd || !issue || !a.pane_id) continue;
      const currentPane = this.lifecycles.get(issue)?.current?.paneId;
      if (currentPane && a.pane_id !== currentPane) continue;
      // More than one live pane at one owned path is ambiguous. Do not let
      // iteration order silently choose which process Butchr controls.
      if (map.has(issue)) {
        map.delete(issue);
        ambiguous.add(issue);
      } else if (!ambiguous.has(issue)) {
        map.set(issue, { pane: a.pane_id, cwd, status: a.agent_status });
      }
    }
    return map;
  }

  async runningIssues(): Promise<string[]> {
    return [...(await this.byIssue()).keys()];
  }

  async managedAgents(): Promise<ManagedHerdAgent[]> {
    return [...(await this.byIssue())].map(([issue, agent]) => ({ issue, ...agent }));
  }

  /**
   * The pane's own foreground provider, or `undefined` when it can't be
   * determined (herdr hiccup/pane gone, a starting shell, an exited process,
   * a pane blocked on a dialog) — shared by `staleIssues()` and `providerOf()`
   * so both trust exactly the same evidence.
   */
  private async providerOfPane(pane: string): Promise<{ provider: ManagedAgentProvider; proc: results.PaneProcessInfoProcess & { argv: string[] } } | undefined> {
    let info: results.PaneProcessInfo | undefined;
    try {
      info = (await this.herdr.pane.processInfo({ pane_id: pane }) as { process_info?: results.PaneProcessInfo }).process_info;
    } catch {
      return undefined; // herdr hiccup / pane gone — unknown
    }
    // foreground_processes/argv are both optional/nullable on the wire: a
    // shell still starting, a claude that already exited, or a pane
    // blocked on a dialog can all report none of this — every such gap is
    // UNKNOWN (a fresh respawn must never itself be respawned every poll —
    // the 7-leaked-workspaces shape, CHANGELOG 0.5.6).
    const proc = info?.foreground_processes?.find((p) => managedAgentProviderOfProcess(p));
    if (!proc?.argv) return undefined; // no claude in the foreground, or the matched claude reported no argv
    return { provider: managedAgentProviderOfProcess(proc)!, proc: proc as results.PaneProcessInfoProcess & { argv: string[] } };
  }

  async providerOf(issue: string): Promise<ManagedAgentProvider | null> {
    const entry = (await this.byIssue()).get(issue);
    if (!entry) return null;
    const found = await this.providerOfPane(entry.pane);
    return found?.provider ?? null;
  }

  async staleIssues(): Promise<StaleAgent[]> {
    // Reconciliation stops stale workers before spawning replacements.
    if (this.agent.provider === "codex" && this.agent.codexSpawnBlocked) return [];
    if (this.agent.provider === "agy" && this.agent.agySpawnBlocked) return [];
    const out: StaleAgent[] = [];
    for (const [issue, { pane, cwd }] of await this.byIssue()) {
      if (this.refused.has(issue)) continue;
      if (!cwd) continue; // no cwd reported — can't build the expected argv — unknown, not stale
      const found = await this.providerOfPane(pane);
      if (!found) continue;
      const { provider, proc } = found;
      // issuetype/summary/parent don't matter here: --model and --effort
      // (the only things issuetype affects) are both deliberately excluded
      // from the comparison.
      if (provider === "agy" && this.agent.agySpawnBlocked) continue;
      const disabledMcpServers = this.agent.disabledMcpServers ?? workspaceIsolation(cwd);
      if (provider === "codex" && disabledMcpServers === undefined) {
        out.push({ issue, reason: "Codex MCP isolation inventory missing", observedArgv: proc.argv });
        continue;
      }
      const decoded = decodeAgentKey(issue);
      // BUTCHR-408/BUTCHR-411: two independent sources feed a spec's
      // mcpServers, kept apart by POPULATION so neither shadows the other's
      // staleness signal. A managed-session agent (filesystem provider,
      // MANAGED_SESSIONS_RULE_ID, BUTCHR-408) has no entry in `rules` at
      // all, so `mcpBindingsOf` could only ever answer "no bindings" for
      // it — its real mcpServers is whatever buildWorkspace last persisted
      // for this workspace (workspaceMcpServers, src/agents/workspace.ts,
      // the SAME read-the-workspace-back shape externalMcpServers below
      // already uses). A rule-engine agent's mcpServers (BUTCHR-411), by
      // contrast, must come from the RULE's CURRENT config, not a persisted
      // file, or an admin removing a binding from rules.json would never
      // read as stale — see the constructor's own doc comment on
      // mcpBindingsOf for why this lookup exists instead of caching the
      // original spawn's SpawnSpec.
      const isManagedSession = decoded?.resourceProvider === "filesystem" && decoded.ruleId === MANAGED_SESSIONS_RULE_ID;
      const mcpServers = isManagedSession ? (workspaceMcpServers(cwd) ?? []) : this.mcpBindingsOf?.(issue);
      // BUTCHR-413: same `accountNameOf` callback `spawn()` itself uses —
      // see that constructor param's own doc comment for why recomputing it
      // fresh here, rather than caching the original spawn's spec, is what
      // keeps this comparison from drifting.
      const accountName = this.accountNameOf?.(issue);
      // FACTORY-43: `spec.permissionMode`/`spec.strictMcpConfig` are the two
      // OTHER fields a managed-session spawn actually carries
      // (specForSessionDefinition, src/rules/session-definition-type.ts)
      // that this reconstruction used to drop entirely — leaving every
      // managed session launched with a non-default permission mode (or
      // strictMcpConfig) permanently stale. Same read-the-workspace-back
      // shape as `mcpServers`/`externalMcpServers` above: whatever
      // buildWorkspace persisted at the real spawn is what "expected" means
      // here, never a value recomputed independently of that spawn.
      const permissionMode = workspacePermissionMode(cwd);
      const strictMcpConfig = workspaceStrictMcpConfig(cwd);
      const expected = spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, ...(decoded ? { resource: decoded.resourceId, externalMcpServers: workspaceExternalMcp(cwd) ?? [] } : {}), ...(mcpServers ? { mcpServers } : {}), ...(accountName ? { rocketchatAccount: accountName } : {}), ...(permissionMode !== undefined ? { permissionMode } : {}), ...(strictMcpConfig !== undefined ? { strictMcpConfig } : {}) }, cwd, { provider, ...(disabledMcpServers ? { disabledMcpServers } : {}) }, this.mcpUrl);
      const check = checkArgv(expected, proc.argv);
      if (!check.ok) { out.push({ issue, reason: check.reason, observedArgv: proc.argv }); continue; }
      // FACTORY-75: `--model`/`--effort` are deliberately excluded from
      // `checkArgv`/`checkManagedAgentArgv`'s own comparison just above
      // (this method's own top comment: "issuetype/summary/parent don't
      // matter here" — Drovr never diffs those two flags at all, for ANY
      // spec), so the two-axis (`modelPower`/`effort`) mechanism's own
      // auto-reconcile-on-change requirement needs its OWN comparison here:
      // whatever this workspace was ACTUALLY spawned with
      // (`workspaceModel`/`workspaceEffort`, read back from what
      // `buildWorkspace` persisted at spawn time) against what the
      // definition/rule CURRENTLY resolves to (`resolvedAgentOf`, live —
      // not persisted, so a definition/rule edit OR a table edit shipped in
      // a new daemon build is caught on the very next poll after whichever
      // of those actually took effect). `resolvedAgentOf` returning
      // `undefined` (nothing this daemon can resolve for this issue), or a
      // model/effort of `undefined` (this provider's own preference sets
      // neither), means nothing to compare — never flagged, the same
      // fail-safe shape `mcpBindingsOf`'s own absence already has.
      //
      // REVIEW FIX (PR #473, first review): a workspace spawned by a build
      // BEFORE this ticket never wrote `.butchr-model.json`/`.butchr-effort.json`
      // at all — `workspaceModel`/`workspaceEffort` return `undefined` for
      // every already-running managed session (tier-based, so `liveResolved.model`
      // is always defined) and every already-running rule agent whose
      // `agentPreferences` already set an explicit `model`/`effort` (unrelated
      // to `modelPower`/`effortPower`). Comparing that `undefined` directly
      // against `liveResolved.model` (always defined for those cases) would
      // flag EVERY one of them stale on the very first poll after deploy — a
      // fleet-wide mass restart, exactly the "unexpected behaviour change on
      // deploy" this ticket's own back-compat requirement forbids, and the
      // same bug SHAPE FACTORY-43 fixed (a stale-check expectation that does
      // not match what the previous launch actually persisted).
      //
      // Fixed by falling back to what `proc.argv` shows the process was
      // ACTUALLY launched with, when the persisted file is absent — Claude
      // always emits both `--model` and `--effort` unconditionally
      // (`agentLaunchConfig`'s claude branch: both fields are non-optional,
      // always resolved via a default), so `argvFlagValue` recovers the
      // real value with no `buildWorkspace` change needed for THIS build to
      // read back a PREVIOUS build's launch. Codex has no `--effort` flag at
      // all (its reasoning effort lives in `.codex/config.toml`, never
      // argv — see `codexReasoningEffortFlag`'s own doc comment,
      // src/resources/power-scale.ts) and `--model` only when explicitly
      // set; with NO persisted file and NO argv signal for Codex effort,
      // there is nothing to compare against, so `?? liveResolved.effort`
      // makes that comparison trivially equal (never flagged) rather than
      // guessing a value — the same "unknown, not stale" fail-safe this
      // file's own `staleIssues()` already uses for a pane that reports
      // nothing (see "no cwd reported" / "pane.process_info rejects" tests).
      // Once a respawn actually happens (this comparison flags a REAL
      // change, or any other reason), the NEW build's `buildWorkspace`
      // persists real values and every later poll compares persisted-vs-live
      // exactly as designed, with no more argv fallback needed.
      const liveResolved = this.resolvedAgentOf?.(issue, provider);
      if (liveResolved) {
        const persistedModel = workspaceModel(cwd) ?? argvFlagValue(proc.argv, "--model");
        // Claude's `--effort` value is always one of AgentEffort's own literals (agentLaunchConfig
        // never emits anything else) — safe to widen back to that type here.
        const observedClaudeEffort = provider === "claude" ? argvFlagValue(proc.argv, "--effort") as AgentEffort | undefined : undefined;
        const persistedEffort = workspaceEffort(cwd) ?? (provider === "claude" ? observedClaudeEffort : liveResolved.effort);
        const modelChanged = liveResolved.model !== undefined && liveResolved.model !== persistedModel;
        const effortChanged = liveResolved.effort !== undefined && liveResolved.effort !== persistedEffort;
        if (modelChanged || effortChanged) {
          out.push({
            issue,
            reason: `argv lacks --model/--effort matching the current definition/rule (model: ${persistedModel ?? "(default)"} -> ${liveResolved.model ?? persistedModel ?? "(default)"}, effort: ${persistedEffort ?? "(default)"} -> ${liveResolved.effort ?? persistedEffort ?? "(default)"})`,
            observedArgv: proc.argv,
            // FACTORY-314: this is the ONLY push site that can ever set
            // `resumable` — reached only after `checkArgv` above already
            // passed (`check.ok`, never the "Codex MCP isolation" or
            // `checkArgv` failure pushes) and only for Claude, the only
            // provider this ticket's `--resume` mechanism covers.
            resumable: provider === "claude",
          });
        }
      }
    }
    return out;
  }

  /**
   * BUTCHR-320 — one `SPAWN_TAG` outcome line per attempt, whatever the
   * outcome, from THIS one place (the design note on the ticket: the pane id
   * is known only here, and both the ordinary spawn loop and the respawn
   * loop in `reconcileNow` call this same method, so a single emit here
   * covers both by construction).
   *
   * THREE OUTCOMES, not two — the no-op early return below (an issue that
   * already has a live agent) is neither a success nor a failure: it
   * attempted nothing. Logging it as a success would inflate the attempt
   * count against (B)'s admitted count for no real work done; logging
   * nothing would make (A)'s total legitimately fall short of (B)'s whenever
   * this races (see below) — so it gets its OWN outcome, "noop", under the
   * SAME tag, and the cross-instrument check (falsifier 2) counts all three
   * outcomes as "attempts". Re-derived at this commit: BUTCHR-287's own
   * residency guard (residency-guard.ts) filters an already-resident
   * candidate out of `plan.spawn` BEFORE admission — but it consults a
   * DIFFERENT signal (a live process in the issue's own workspace directory)
   * than this check (`byIssue()`, i.e. `agent.list()`), and `plan.spawn`
   * itself is computed from an `agent.list()` snapshot taken once at the top
   * of `reconcileNow` — so a TOCTOU gap between that snapshot and this
   * method's own fresh `byIssue()` read (e.g. a concurrent respawn of the
   * same issue elsewhere) can still reach this early return. Neither guard
   * makes it unreachable; both are independent lines of defense.
   *
   * Success is logged after Drovr verifies the current worker remains
   * present and checks the measured Claude quota signal. Provider handoff
   * also requires an acknowledged native working summary before commit.
   * Idle/done alone does not prove kickoff was swallowed; it is not resent.
   *
   * FAILURE IS LOGGED WHATEVER THE COMPLAINT/LATCH STATE (hard constraint on
   * the ticket): this method's own `log` call is the ONLY place a failure is
   * recorded to the journal, entirely independent of
   * `reconcile-failure.ts`'s `ReconcileFailureTracker.isSpoken` latch (that
   * latch only ever gates whether a JIRA COMMENT is posted — see that
   * module's own doc comment, confirmed at this commit: `check()` calls
   * `isSpoken` before its own "not yet posting" log line, so a latched
   * episode produces no journal line there at all). This method never
   * consults that latch, so a failure is logged here every single time,
   * complaint-latched or not.
   *
   * BUTCHR-320 review fix (round 1): the no-op check's OWN `byIssue()` read
   * is inside the `try` below, not before it — see that line's own comment.
   * A rejecting `agent.list()` there used to reject `spawn()` having emitted
   * NO line at all, which is exactly the silent-failure defect this whole
   * ticket exists to close, surviving inside the fix for it: `attempts =
   * successes + failures + noops` did not hold whenever this raced, and a
   * `[spawn]`-derived failure count was a floor, not a count, the same shape
   * as finding (3)'s latched-complaint undercount. Measured to actually
   * reach zero lines on a rejecting `agent.list()`, at this method's
   * pre-fix shape, before this fix landed.
   */
  async spawn(specIn: SpawnSpec, origin: SpawnOrigin = "spawn"): Promise<void> {
    // BUTCHR-413: a fallback fill only, never an overwrite — BUTCHR-412's
    // own `account-lifecycle.ts` `ensure()` already sets `rocketchatAccount`
    // on `desired`/`toSpawn` BEFORE `herd.spawn` is ever called, from the
    // REAL `ensureAccount` outcome for this launch (respecting a cap
    // refusal, a not-managed collision, etc. — cases where `ensure` instead
    // returns `null` and this method is never reached at all). Both
    // producers derive the identical value from the same agent key
    // (`rcUsernameFor`, src/accounts/identity.ts), so this is never a
    // disagreement — only a fallback for a launch path that never went
    // through `ensure` at all (no accountLifecycle wired, e.g. RC not
    // configured for any rule). See `staleIssues()` below for the SAME
    // callback used to keep its own reconstruction in sync.
    const accountName = specIn.rocketchatAccount ?? this.accountNameOf?.(specIn.key);
    const spec: SpawnSpec = accountName ? { ...specIn, rocketchatAccount: accountName } : specIn;
    return this.exclusive(spec.key, () => this.spawnExclusive(spec, origin));
  }

  private async spawnExclusive(spec: SpawnSpec, origin: SpawnOrigin): Promise<void> {
    const issue = spec.key;
    try {
      // BUTCHR-320 review fix (round 1): the no-op check itself is inside
      // the try now, not before it. `byIssue()` is `agent.list()` with no
      // error handling of its own, and it is the THIRD OR LATER
      // `agent.list()` call of the poll (after `reconcileNow`'s own snapshot
      // and admission's `residency()` read), so a transient herdr hiccup
      // reaching exactly here — a first-class expected event in this
      // codebase, see `staleIssues()`'s own "herdr hiccup / pane gone —
      // unknown, not stale" and `MAX_IMPLAUSIBLE_POLLS`'s own doc comment —
      // used to reject `spawn()` having emitted NO line at all: a silent
      // failure surviving inside the very fix for silent failures. `return`
      // still exits the no-op path before the `catch` below, so the three
      // outcomes are unchanged; only a REJECTING `byIssue()` now falls
      // through to the same `failed` line every other failure gets.
      if ((await this.byIssue()).has(issue)) {
        this.log?.(`${SPAWN_TAG} ${issue} noop — already has a live agent origin=${origin}`);
        return;
      }
      const result = await this.startProviders(spec);
      if (result.status !== "success") {
        this.log?.(`${SPAWN_TAG} ${issue} waiting - ${result.status === "blocked" ? "handoff blocked" : "providers exhausted"} origin=${origin}`);
        return;
      }
      // FACTORY-75 visibility requirement: the resolved (model, effort)
      // pair this spawn intended (`spec.agents`, whatever
      // `specForSessionDefinition`/`rule.agentPreferences` resolved via the
      // two-axis mechanism, src/resources/power-scale.ts) rides on the SAME
      // journal line every other spawn outcome already gets — never a
      // separate log call that could land out of order with this one.
      const agentsNote = spec.agents?.length ? ` agents=${JSON.stringify(spec.agents)}` : "";
      this.log?.(`${SPAWN_TAG} ${issue} succeeded — pane ${result.value} origin=${origin}${agentsNote}`);
    } catch (e) {
      this.log?.(`${SPAWN_TAG} ${issue} failed origin=${origin} — ${(e as Error)?.message ?? e}`);
      throw e;
    }
  }

  /**
   * FACTORY-95 review fix (round 1): `resolveDisplayLabels`'s tie-break is
   * the lexicographically SMALLEST key of a colliding group — a pure
   * function of the full key set, deliberately independent of spawn order
   * (see that function's own doc comment). That independence has a sharp
   * consequence at THIS call site: when the key about to spawn sorts
   * BEFORE an already-running colliding key, the incoming key is handed the
   * bare label while the running workspace still visibly carries that same
   * bare label from ITS OWN earlier spawn/relabel — two live workspaces
   * sharing one label until the next `relabelOwnedWorkspaces()` pass, which
   * only runs at daemon startup. FACTORY-90 is explicit that a collision
   * must be disambiguated, not left to share a label, so this cannot wait
   * for a restart.
   *
   * The fix: after resolving `key`'s own label against the full running
   * set, ALSO reasserts every OTHER running member of `key`'s own
   * collision group's own correct label — right now, via the SAME
   * `relabelRunningAgent` path `relabelOwnedWorkspaces` uses below.
   * Unconditional, not "only the ones that changed": both herdr calls are
   * plain, cheap overwrites, and reasserting a sibling whose label happens
   * to be unchanged costs nothing while never depending on trusting that
   * herdr's own stored value already agrees (it might not, e.g. after an
   * interrupted earlier attempt). This keeps the invariant "no two live
   * workspaces share a label" true at every instant, not just after a
   * restart, and keeps the spawn path and relabel-in-place path using the
   * literal same tie-break over the literal same kind of set — the "same
   * agent -> same label both ways" property `resolveDisplayLabels` promises
   * is what makes recomputing safe to do here.
   */
  private async labelFor(key: string): Promise<string> {
    const owned = await this.ownedWorkspaceIds();
    const running = [...owned.keys()];
    const keys = running.includes(key) ? running : [...running, key];
    const labels = resolveDisplayLabels(keys, this.log);
    const myBase = baseDisplayLabel(key);
    for (const other of running) {
      if (other === key || baseDisplayLabel(other) !== myBase) continue;
      const newLabel = labels.get(other);
      const workspaceId = owned.get(other);
      if (newLabel && workspaceId) await this.relabelRunningAgent(other, workspaceId, newLabel);
    }
    return labels.get(key) ?? key;
  }

  private async startProviders(spec: SpawnSpec, refusedPane?: string) {
    await instanceFreezeStore.assertRunnable(`butchr:${spec.key}`);
    if(!this.freezeWatches.has(spec.key)) this.freezeWatches.set(spec.key,watchInstanceFreeze(`butchr:${spec.key}`,()=>this.stop(spec.key),{onError:e=>this.log?.(String(e))}));
    const label = await this.labelFor(spec.key);
    // FACTORY-314 (PR #513 review fix): captured by `prepare()` below, purely
    // so a SUCCESSFUL Claude launch can discover its REAL session id
    // afterward (see the `result.status === "success"` block) — `prepare()`
    // is the only place that resolves `home`, and it isn't part of
    // `ManagedHerdrResult`, so there is nothing to read it back from otherwise.
    let preparedHome: string | undefined;
    // FACTORY-314 (epic review on PR #513, "trap 2"): the wall-clock instant
    // BEFORE the launch attempt begins — the lower bound `discoverClaudeSessionId`
    // filters candidate transcripts against, so a workspace directory that
    // already holds an OLDER transcript (a prior respawn of this SAME
    // issue) can never be silently mistaken for this launch's own. `Date.now()`,
    // not `this.monotonicNow()`: transcript timestamps are wall-clock, and
    // `monotonicNow` is deliberately unrelated to it (see that field's own
    // doc comment) — the two are never comparable.
    const launchStartedAt = Date.now();
    const result = await this.lifecycle(spec.key).start({
      priority: (spec.agents?.length ? [...new Set(spec.agents.map((p) => p.harness))] : providerOrder(this.agent, spec.issuetype)).map(provider => ({ provider, accountId: "default" })),
      label,
      ...(refusedPane ? { replacePaneId: refusedPane } : {}),
      // BUTCHR-408 review fix: `spec`-aware, not the bare `kickoffFor`
      // reference — see `kickoffFor`'s own doc comment (src/agents/argv.ts)
      // for why a spec with `cwd` needs its OWN kickoff (told to `cd` into
      // its real working directory, then follow its definition's own
      // brief — the launched process itself still starts at the ordinary
      // bookkeeping directory). Every other spec (no `cwd`) is unaffected.
      kickoff: (provider) => kickoffFor(provider, spec),
      prepare: async provider => {
        const selected: AgentConfig = { ...this.agent, provider };
        if (provider !== this.agent.provider) delete selected.model;
        // A rule's own preference for this harness (its first entry naming it) overrides the global model.
        const preference = spec.agents?.find((p) => p.harness === provider);
        if (preference?.model) selected.model = preference.model;
        if (preference?.effort) selected.effort = preference.effort;
        if (provider === "codex" && selected.codexSpawnBlocked) throw new Error(selected.codexSpawnBlocked);
        if (provider === "agy" && selected.agySpawnBlocked) throw new Error(selected.agySpawnBlocked);
        const dir = buildWorkspace(spec, this.mcpUrl, provider, selected.disabledMcpServers);
        const launch = agentLaunchConfig(spec, dir, "pending", nameFor(spec.key), selected, this.mcpUrl);
        const prepared = await this.prepareWorkspace({ provider, cwd: dir, unattended: true });
        const home = prepared && typeof prepared === "object" && "HOME" in prepared && typeof prepared.HOME === "string"
          ? prepared.HOME : undefined;
        preparedHome = home;
        return { launch, ...(home ? { env: { HOME: home }, home } : {}) };
      },
    });
    if (result.status === "success") {
      this.refused.delete(spec.key);
      await this.reportFullAgentKey(spec.key);
      // FACTORY-314 (PR #513 review fix): a fresh Claude launch runs under
      // Claude's OWN auto-generated session id — nothing butchr passes
      // reaches the real launch argv (`ManagedHerdrLifecycle.start()` builds
      // its own `agent.start` params via Drovr's `buildAgentStartParams`,
      // which has no `--session-id` concept at all; see `agentStartParams`'s
      // own doc comment in src/agents/argv.ts for the ONE place that DOES,
      // never reached by this path). So the real id is discovered AFTER the
      // fact, from Claude's own transcript directory for this workspace
      // (`discoverClaudeSessionId`, src/agents/workspace.ts) — the newest
      // transcript for this cwd, right after a launch this method itself
      // just confirmed succeeded, is unambiguous. Persisted so a later
      // model/effort-only change can `--resume` it for real, instead of a
      // pre-minted id Claude never actually used.
      //
      // RETRIED, not a single check: MEASURED live against a real herdr
      // (throwaway workspace, real `HerdrHerd.spawn()`) that a single
      // discovery attempt immediately after `ManagedHerdrLifecycle.start()`
      // returns can race Claude's own transcript-file creation and find
      // nothing — `KICKOFF_VERIFY_MS` (drovr, ~12s) confirms the AGENT is
      // idle/alive, not that its transcript file has been written yet
      // (slower under MCP-connection retries, model cold-start, etc.). A
      // bounded poll closes this gap cheaply: the common case still returns
      // on the FIRST check (the file is usually already there).
      if (result.account.provider === "claude") {
        const dir = workspaceDirFor(spec.key);
        let discovered: string | undefined;
        for (let attempt = 0; attempt < SESSION_DISCOVERY_ATTEMPTS; attempt++) {
          discovered = discoverClaudeSessionId(dir, preparedHome, launchStartedAt);
          if (discovered || attempt === SESSION_DISCOVERY_ATTEMPTS - 1) break;
          await this.wait(SESSION_DISCOVERY_POLL_MS);
        }
        if (discovered) persistDiscoveredSessionId(dir, discovered);
        else {
          // FACTORY-314 (epic review, round 3): MUST invalidate, not just log —
          // an earlier launch of this SAME workspace may have persisted a
          // session id of its own, and leaving it on disk here means a LATER
          // model/effort change would find that OLDER id, find its transcript
          // still sitting in the same per-cwd project folder (`claudeTranscriptExists`
          // is a bare existsSync), and `--resume` it: a silent, confidently
          // wrong resume into a different, already-finished conversation,
          // reported as "PRESERVED". Removing it makes `workspaceSessionId`
          // fail safe to `undefined`, so `resumeInPlace()`'s existing
          // `if (!sessionId) return "unresumable"` check catches this launch
          // instead — an honest fresh restart next time, never a wrong guess.
          invalidatePersistedSessionId(dir);
          this.log?.(`WARNING: [spawn] ${spec.key} could not discover a native Claude session id after a successful launch — a later model/effort change will fall back to a fresh restart instead of resuming`);
        }
      }
    } else {
      if (result.status === "blocked") this.log?.(`[provider-fallback] ${spec.key} blocked: ${result.reason}`);
      const current = await this.lifecycle(spec.key).resolveCurrent();
      if ((current?.agent === "claude" || current?.agent === "codex") && (current.agent_status === "idle" || current.agent_status === "done")) {
        this.observeQuota(spec.key, current, await this.readPane(current.pane_id));
      }
    }
    return result;
  }

  /**
   * FACTORY-95: preserves the full agent key in herdr's own per-workspace
   * metadata bag, keyed by `FULL_AGENT_KEY_METADATA_FIELD` — the herdr-facing
   * label carries only the short display id (`labelFor` above), so this is
   * the one place the FULL key is retrievable from herdr for a given
   * workspace. `resolveCurrent()` re-resolves this agent's own live identity
   * (pane id AND `workspace_id`) rather than trusting anything cached — the
   * SAME re-resolution `startProviders`' own failure branch already does a
   * few lines up. Never throws and never logged as a SPAWN_TAG outcome: a
   * metadata-write hiccup must never read as a failed spawn (the agent is
   * already running) — logged as its own WARNING, swallowed, exactly like
   * `relabelOwnedWorkspaces` below treats the same two herdr calls.
   */
  private async reportFullAgentKey(key: string): Promise<void> {
    try {
      const current = await this.lifecycle(key).resolveCurrent();
      if (!current) return; // resolved away already (e.g. immediately stopped) — nothing to tag
      await this.herdr.workspace.reportMetadata({
        workspace_id: current.workspace_id,
        source: METADATA_SOURCE,
        tokens: { [FULL_AGENT_KEY_METADATA_FIELD]: key },
      });
    } catch (e) {
      this.log?.(`WARNING: [spawn] ${key} metadata report failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * FACTORY-95 (implementing FACTORY-90): every currently-running,
   * butchr-owned workspace's own `workspace_id`, keyed by its REAL agent key
   * — derived from a pane's `cwd` via the shared `agentIdOfWorkspacePath`
   * (src/agents/workspace.ts), NEVER via herdr's own current label (that is
   * exactly the thing `relabelOwnedWorkspaces` below is about to change, so
   * it can never double as an identity source — the same ownership
   * discipline `reap.ts`'s `strandedCandidates` already documents for its
   * own, differently-scoped join). Deliberately its OWN small join over
   * `agent.list()`, not a `byIssue()` reuse: `byIssue()`'s map feeds the
   * public `managedAgents()`/`ManagedHerdAgent` shape, which has no
   * `workspaceId` field — duplicating this ambiguity-safe loop here keeps
   * that public contract unchanged. "Ambiguous" (more than one live pane at
   * one owned cwd) is dropped rather than guessed, same rule `byIssue()`
   * already applies for the identical reason.
   */
  private async ownedWorkspaceIds(): Promise<Map<string, string>> {
    const { agents } = await this.herdr.agent.list();
    const map = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const a of agents) {
      const key = agentIdOfWorkspacePath(a.cwd ?? null);
      if (!key || !a.workspace_id) continue;
      if (map.has(key)) { map.delete(key); ambiguous.add(key); }
      else if (!ambiguous.has(key)) map.set(key, a.workspace_id);
    }
    return map;
  }

  /**
   * FACTORY-95: renames one ALREADY-RUNNING agent's workspace and refreshes
   * its metadata — the one shared herdr-write path both `labelFor` above
   * (fixing up a spawn's OWN colliding siblings, right now, not at the next
   * restart) and `relabelOwnedWorkspaces` below (the full-fleet pass) use,
   * so the two can never diverge in what a "relabel" actually does on the
   * wire. Never throws: caught and logged as its own WARNING, exactly like
   * `reap.ts`'s own per-candidate fault isolation — one workspace's failure
   * must never block another's, or the caller that triggered it.
   */
  private async relabelRunningAgent(agentKey: string, workspaceId: string, label: string): Promise<void> {
    try {
      await this.herdr.workspace.rename({ workspace_id: workspaceId, label });
      await this.herdr.workspace.reportMetadata({
        workspace_id: workspaceId,
        source: METADATA_SOURCE,
        tokens: { [FULL_AGENT_KEY_METADATA_FIELD]: agentKey },
      });
    } catch (e) {
      this.log?.(`WARNING: [relabel] ${agentKey} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * FACTORY-95 (implementing FACTORY-90): relabels every currently-running,
   * butchr-owned herdr workspace to its short display label
   * (`resolveDisplayLabels`, src/rules/display-label.ts) and refreshes its
   * metadata with the full agent key — no agent restart, `workspace.rename`/
   * `workspace.reportMetadata` alone (`relabelRunningAgent` above).
   * Idempotent: safe to call repeatedly (today's only caller runs it once at
   * daemon startup — src/daemon/index.ts; `labelFor` above also calls
   * `relabelRunningAgent` directly, mid-spawn, for the narrower case of a
   * spawn's own colliding siblings) since both herdr calls are themselves
   * plain overwrites, never additive. Never throws: an overall failure (a
   * herdr hiccup on `agent.list()`) is logged and swallowed, and each
   * workspace's own rename/metadata failure is isolated by
   * `relabelRunningAgent` itself — the same fault isolation `reap.ts`'s own
   * `Reaper.check()` gives its per-candidate work, so one bad workspace
   * never blocks the rest.
   */
  async relabelOwnedWorkspaces(): Promise<void> {
    try {
      const owned = await this.ownedWorkspaceIds();
      if (!owned.size) return;
      const labels = resolveDisplayLabels([...owned.keys()], this.log);
      for (const [agentKey, workspaceId] of owned) {
        await this.relabelRunningAgent(agentKey, workspaceId, labels.get(agentKey) ?? agentKey);
      }
    } catch (e) {
      this.log?.(`WARNING: [relabel] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  private async readPane(paneId: string): Promise<string> {
    const r = await this.herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true } as Parameters<DrovrClient["pane"]["read"]>[0]);
    return (r as { read: { text: string } }).read.text;
  }

  async stop(issue: string): Promise<void> {
    await this.exclusive(issue, async () => {
      await this.lifecycle(issue).stop();
      this.freezeWatches.get(issue)?.close();this.freezeWatches.delete(issue);
      this.refused.delete(issue);
    });
  }

  async paneFor(issue: string): Promise<string | null> {
    return (await this.byIssue()).get(issue)?.pane ?? null;
  }

  /** See the `Herd.resumeInPlace` interface doc for the full contract. */
  async resumeInPlace(spec: SpawnSpec): Promise<"resumed" | "deferred" | "stuck" | "unresumable" | "failed"> {
    return this.exclusive(spec.key, () => this.resumeInPlaceExclusive(spec));
  }

  private async resumeInPlaceExclusive(spec: SpawnSpec): Promise<"resumed" | "deferred" | "stuck" | "unresumable" | "failed"> {
    const issue = spec.key;
    // Routed through `this.exclusive` (above), the SAME per-issue queue
    // `spawn()`/`stop()` already use — a concurrent ordinary `herd.spawn()`
    // for this same issue (e.g. a reconcile poll landing mid-relaunch, which
    // would otherwise see a bare shell in `byIssue()` and treat this issue
    // as "desired but not running") simply queues behind this call and, once
    // it runs, finds the resumed agent already present (`spawnExclusive`'s
    // own no-op check) — it never reaches `ManagedHerdrLifecycle.start()` at
    // all, so FACTORY-300's `this.active`-can't-resolve `HandoffBlocked`
    // never triggers from this window. Verified with a fake-`Herd`
    // reconcile-path test (test/unit/herd.test.ts) that fires a concurrent
    // `spawn()` mid-window and asserts exactly this: no throw, no duplicate
    // pane, a plain no-op after the resume settles.
    const entry = (await this.byIssue()).get(issue);
    if (!entry) return "unresumable"; // no longer running — nothing to resume; the ordinary spawn loop picks it up
    const { pane, cwd } = entry;
    const sessionId = workspaceSessionId(cwd);
    if (!sessionId) return "unresumable"; // pre-FACTORY-314 workspace (or genuinely unknown) — caller falls back to fresh-restart with an honest "session lost: session id could not be determined" reason
    const found = await this.providerOfPane(pane);
    if (!found || found.provider !== "claude") return "unresumable"; // this ticket's --resume mechanism covers Claude only
    // FACTORY-314 (PR #513 review fix): verify the id we are ABOUT TO RESUME
    // still has a real transcript before doing anything else — a stale or
    // corrupted persisted id must fail safe to "unresumable" (an honest
    // fresh restart) rather than attempting to resume a conversation that
    // no longer exists. Same `home` resolution `spawnExclusive`'s own
    // `prepare()` uses, since that's what determines where Claude's
    // transcripts actually live for an isolated-HOME launch.
    const prepared = await this.prepareWorkspace({ provider: "claude", cwd, unattended: true });
    const home = prepared && typeof prepared === "object" && "HOME" in prepared && typeof prepared.HOME === "string" ? prepared.HOME : undefined;
    if (!claudeTranscriptExists(cwd, sessionId, home)) return "unresumable";
    // Idle-only, race-closed as tightly as this SDK allows: two reads of the
    // SAME evidence (`agent_status`) back-to-back, immediately before acting
    // — see `Herd.resumeInPlace`'s own doc comment for why no finer
    // "a turn just started" signal exists here to close this tighter.
    const isIdle = async () => {
      const current = await this.lifecycle(issue).resolveCurrent().catch(() => undefined);
      return current?.agent_status === "idle" || current?.agent_status === "done";
    };
    if (!(await isIdle())) return "deferred";
    if (!(await isIdle())) return "deferred";
    await this.herdr.pane.sendText({ pane_id: pane, text: "/exit" } as Parameters<DrovrClient["pane"]["sendText"]>[0]);
    await this.herdr.pane.sendKeys({ pane_id: pane, keys: ["enter"] } as Parameters<DrovrClient["pane"]["sendKeys"]>[0]);
    const deadline = this.monotonicNow() + RESUME_EXIT_TIMEOUT_MS;
    while (this.monotonicNow() < deadline && (await this.providerOfPane(pane))) {
      await this.wait(RESUME_EXIT_POLL_MS);
    }
    if (await this.providerOfPane(pane)) return "stuck"; // never returned to a shell (a dialog, a hang) — do NOT relaunch onto it, do NOT kill it; leave the agent alone for a human/next-poll
    const preference = spec.agents?.find((p) => p.harness === "claude");
    const selected: AgentConfig = { ...this.agent, provider: "claude", resumeSessionId: sessionId };
    if (preference?.model) selected.model = preference.model;
    if (preference?.effort) selected.effort = preference.effort;
    // FACTORY-312 review (26137, point 1): the argv is built from `cwd`
    // DIRECTLY — deliberately NOT via `buildWorkspace()` here, before the
    // relaunch is even attempted. Persisting the new model/effort BEFORE
    // knowing the relaunch succeeded would make a FAILED resume
    // indistinguishable from a healthy one on the very next poll (the
    // persisted-vs-live comparison would already "match", so a stuck-on-old-
    // flags agent would never be flagged again). Same shared builder
    // (`agentStartParams`, src/agents/argv.ts) a fresh launch and
    // `staleIssues()`'s own comparison use, so this relaunch's argv shape is
    // judged by the identical module that built it — the SAME pane_id as
    // before, never a new workspace/pane, unlike a fresh spawn.
    const params = agentStartParams(spec, cwd, pane, nameFor(issue), selected, this.mcpUrl);
    try {
      await startManagedAgent(this.herdr, params, { readinessTimeoutMs: PANE_READINESS_TIMEOUT_MS, retryIntervalMs: PANE_READY_WAIT_MS, now: this.monotonicNow, wait: this.wait });
    } catch (e) {
      // FACTORY-314 (PR #513 review fix, live-tested against a real herdr):
      // MEASURED — the OLD claude process can still hold this pane's agent
      // name in herdr's own bookkeeping for a moment even after
      // `providerOfPane` above stopped seeing it in the foreground (a
      // narrow gap between "no longer the reported foreground process" and
      // "herdr has fully released the name"), so `agent.start` here can
      // genuinely reject with `agent_name_taken` even though every check
      // above passed. This is exactly the "can't safely tell it's clear"
      // shape `"stuck"` already exists for — do NOT let it surface as a
      // raw thrown failure (which would still be safe, just needlessly
      // alarming for a condition that resolves itself next poll): report
      // it the same non-destructive way as a pane that never left claude's
      // foreground. Any OTHER error is a genuine failure and still throws.
      if (e instanceof HerdrError && e.code === "agent_name_taken") return "stuck";
      throw e;
    }
    // FACTORY-312 review (26137, point 2): herdr accepting the launch only
    // means the PROCESS started — an unavailable model (Step 0.2: measured
    // exit 1, "issue with the selected model") or any other immediate
    // failure exits the pane back to a shell within seconds, and
    // `startManagedAgent`'s own readiness wait does not catch that (it only
    // retries herdr's `agent_pane_busy`, never checks the process stays
    // alive). A brief settle-and-verify closes that gap: if claude did not
    // stay up, this resume attempt FAILED — no loop, no empty pane left
    // behind (a claude process may still be there, exited to a fresh shell
    // prompt, which the caller's own eventual fresh spawn reclaims), and the
    // model/effort files are correctly left UNCHANGED (see the ordering note
    // above) — a real, distinct failure, not a "resumed".
    await this.wait(RESUME_LAUNCH_VERIFY_MS);
    const launched = await this.providerOfPane(pane);
    if (!launched || launched.provider !== "claude") return "failed";
    // Re-persists model/effort/permission-mode/etc. for THIS relaunch, ONLY
    // now that it's confirmed alive. Session id is untouched by
    // `buildWorkspace()` (it no longer manages that file at all — see
    // `discoverClaudeSessionId`/`persistDiscoveredSessionId`,
    // src/agents/workspace.ts): a `--resume` relaunch keeps the SAME id by
    // definition, so there is nothing to rediscover here. The very next
    // poll's `staleIssues()` then compares model/effort against these NEW
    // values and does not flag this agent stale again (FACTORY-43 no-loop).
    buildWorkspace(spec, this.mcpUrl, "claude", selected.disabledMcpServers);
    return "resumed";
  }

  /**
   * BUTCHR-245: this poll's stranded-and-owned workspace candidates — the
   * "thin method" seam `strandedCandidates` (reap.ts) needs no herdr I/O of
   * its own; this method supplies it, deliberately independent of
   * `byIssue()`/`agent.list()`-keyed state elsewhere in this class (the
   * ownership half of `strandedCandidates` never touches `agent.list()` at
   * all — see that function's own doc comment).
   */
  async strandedCandidates(): Promise<StrandedCandidate[]> {
    const [{ workspaces }, { panes }, { agents }] = await Promise.all([
      this.herdr.workspace.list(),
      this.herdr.pane.list(),
      this.herdr.agent.list(),
    ]);
    return strandedCandidates(workspaces, panes, agents, workspaceRoot());
  }

  /**
   * BUTCHR-287 — a live per-issue residency census, independent of
   * `agent.list()`: for each of `candidates`, whether a pane at that
   * issue's OWN workspace directory (`buildWorkspace()`'s convention,
   * checked by `panesFor` — residency-census.ts) currently shows a live
   * claude in its foreground, reusing the exact `processInfo`/`isClaude`
   * check `paneVerdict` already applies as the reaper's decisive safety
   * layer. `pane.list()` itself is one whole-herd read (herdr has no
   * narrower query); only the `processInfo` calls that follow are scoped
   * to `candidates` — see residency-guard.ts's own doc comment for why
   * that scoping is what keeps this cheap in the common case (an empty or
   * small `plan.spawn`).
   *
   * Deliberately NOT part of the `Herd` interface (mirrors
   * `strandedCandidates`/`closeStranded` above — herdr I/O with no
   * `ownsId` scoping need, since `candidates` already arrives pre-scoped
   * from the caller's own `desired` set): see src/agents/residency-guard.ts
   * for the per-poll orchestration that calls this. A `pane.list()` fetch
   * failure reports every candidate "unknown" rather than throwing — same
   * unknown-≠-vacant discipline `staleIssues()`/`paneVerdict()` already
   * apply, and it leaves the decision of what unknown means to the caller
   * (residency-guard.ts) rather than baking one in here.
   */
  async residency(candidates: readonly string[]): Promise<ReadonlyMap<string, ResidencyVerdict>> {
    const out = new Map<string, ResidencyVerdict>();
    if (!candidates.length) return out;
    let panes: readonly results.PaneInfo[];
    try {
      ({ panes } = await this.herdr.pane.list());
    } catch {
      for (const id of candidates) out.set(id, "unknown");
      return out;
    }
    const root = workspaceRoot();
    for (const id of candidates) {
      const owned = panesFor(id, panes, root);
      const verdicts = await Promise.all(owned.map((p) => this.paneVerdict(p.pane_id)));
      out.set(id, aggregateVerdict(verdicts));
    }
    return out;
  }

  /**
   * BUTCHR-287 — the minimal reusable shape of the census above: every
   * currently-RESIDENT issue key, with no candidate list supplied at all
   * (a whole-herd sweep, via `groupOwnedPanes` rather than `panesFor` —
   * residency-census.ts), built on the exact same primitives as
   * `residency()`. Exposed so a future consumer needing only "which issues
   * are alive right now" (e.g. BUTCHR-284's admission cap, whose own
   * `residency` dependency is already shaped `() => Promise<readonly
   * string[]>`) can point at it with a one-line change — NOT wired to
   * anything in this ticket; that wiring is a deliberate follow-up owned
   * elsewhere (see this ticket's own report for why).
   *
   * Throws rather than reporting an empty list on a `pane.list()` failure
   * (unlike `residency()` above, which reports "unknown" per candidate):
   * a bare `[]` here would be indistinguishable from "genuinely nothing is
   * resident" to a caller that only asked for resident KEYS with no
   * unknown channel to report into — exactly the confident-zero hazard
   * this whole ticket exists to close. A future caller must decide its own
   * fail-open/fail-safe behaviour on a rejection, not inherit a silent
   * zero from this method.
   */
  async residentIssues(): Promise<readonly string[]> {
    const { panes } = await this.herdr.pane.list();
    const grouped = groupOwnedPanes(panes, workspaceRoot());
    const out: string[] = [];
    for (const [issue, ownedPanes] of grouped) {
      const verdicts = await Promise.all(ownedPanes.map((p) => this.paneVerdict(p.pane_id)));
      if (aggregateVerdict(verdicts) === "resident") out.push(issue);
    }
    return out;
  }

  /**
   * BUTCHR-245: verify ONE stranded candidate is genuinely dead — the
   * decisive safety layer (reap.ts's own top comment names three; this is
   * layer 2). Reap only if `pane.processInfo` SUCCEEDS for every one of the
   * candidate's panes and NONE reports a claude process in its foreground
   * (`isClaude`, this file). A thrown call, a missing `process_info`, or an
   * empty `foreground_processes` are all UNKNOWN, never dead — same
   * unknown-≠-stale discipline `staleIssues()` above already applies, for
   * the same reason (a fresh respawn's pane, or a herdr hiccup, must never
   * read as proof of death). Never throws: a herdr rejection on the verify
   * OR the close resolves `false` — "not reaped this poll" — never
   * propagates into the caller's per-poll loop (`reap.ts`'s `createReaper`
   * additionally wraps this call too — belt and suspenders, matching this
   * ticket's own "each close catches its own rejection" requirement).
   */
  async closeStranded(candidate: StrandedCandidate): Promise<boolean> {
    try {
      const verdict = await this.workspaceVerdict(candidate.paneIds);
      if (verdict !== "dead") return false;
      await this.herdr.workspace.close({ workspace_id: candidate.workspaceId } as Parameters<DrovrClient["workspace"]["close"]>[0]);
      return true;
    } catch {
      return false;
    }
  }

  /** "dead" only if EVERY pane's own verdict is "dead" (see `paneVerdict`); a single "live" pane vetoes the whole workspace immediately, a single "unknown" pane makes the whole workspace "unknown" (never "dead") but does not short-circuit — every pane is still checked, since a LATER pane could still veto with "live". */
  private async workspaceVerdict(paneIds: readonly string[]): Promise<"live" | "dead" | "unknown"> {
    if (!paneIds.length) return "unknown"; // no panes reported for this workspace — nothing to verify against
    let allDead = true;
    for (const paneId of paneIds) {
      const v = await this.paneVerdict(paneId);
      if (v === "live") return "live";
      if (v === "unknown") allDead = false;
    }
    return allDead ? "dead" : "unknown";
  }

  /**
   * "dead" requires a SUCCESSFUL processInfo call reporting at least one
   * identified foreground process, none of which is claude (e.g. the
   * measured `fish`/`/usr/bin/fish` shape). Deliberately NOT "dead" for an
   * empty `foreground_processes` — herdr reporting the call succeeded but
   * found nothing there is not proof nothing is there; it's exactly as
   * unverifiable as a thrown call or a missing `process_info`.
   */
  private async paneVerdict(paneId: string): Promise<"live" | "dead" | "unknown"> {
    let info: results.PaneProcessInfo | undefined;
    try {
      info = (await this.herdr.pane.processInfo({ pane_id: paneId }) as { process_info?: results.PaneProcessInfo }).process_info;
    } catch {
      return "unknown";
    }
    const procs = info?.foreground_processes;
    if (!procs || procs.length === 0) return "unknown";
    return procs.some((p) => managedAgentProviderOfProcess(p)) ? "live" : "dead";
  }

  async nudge(issue: string, text: string): Promise<NudgeResult> {
    return this.exclusive(issue, async () => {
      const lifecycle = this.lifecycle(issue);
      try {
        await instanceFreezeStore.assertRunnable(`butchr:${issue}`);
        const prompted = await lifecycle.prompt(text);
        if (!prompted || prompted.agent_status === "blocked") return { delivered: false };
        // Codex accepts follow-ups in its native input path. Do not hold the
        // channel relay behind Claude's delayed quota-dialog observation.
        if (prompted.agent === "codex") return { delivered: true };
      } catch { return { delivered: false }; }
      await this.wait(NUDGE_VERIFY_MS);
      const current = await lifecycle.resolveCurrent().catch(() => undefined);
      if (current?.agent_status === "idle") {
        const screen = await this.readPane(current.pane_id).catch(() => "");
        const refusal = this.observeQuota(issue, current, screen);
        if (refusal) return { delivered: true, refusal };
        await this.herdr.pane.sendKeys({ pane_id: current.pane_id, keys: ["enter"] }).catch(() => {});
      }
      return { delivered: true };
    });
  }
}

export { nameFor as agentNameFor };
