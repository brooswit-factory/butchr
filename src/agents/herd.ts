import { createHash } from "node:crypto";
import { ManagedHerdrLifecycle, managedAgentProviderOfProcess, ProviderAvailabilityRegistry, processProviderAvailability, type ManagedAgentProvider, type DrovrClient, type results } from "@brooswit/drovr";
import { prepareFactoryWorkspace } from "../mcp/registration.js";
import { buildWorkspace, agentIdOfWorkspacePath, workspaceDirFor, workspaceRoot, workspaceIsolation, type SpawnSpec } from "./workspace.js";
import { decodeAgentKey } from "../rules/agent-key.js";
import { agentLaunchConfig, kickoffFor, spawnArgs, checkArgv, providerOrder, type AgentConfig } from "./argv.js";
import { detectSessionLimitRefusal, type SessionLimitRefusal } from "./session-limit.js";
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
}

/** What the reconcile loop needs from herdr. Abstracted so it fakes cleanly in tests. */
export interface Herd {
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
 * BUTCHR-334: which reconcile loop produced a given `spawn()` attempt — see
 * `SPAWN_TAG`'s own doc comment for the cross-instrument rule this exists to
 * close. `spawn()` itself cannot know this (both loops call the same
 * method); the caller does, so it is threaded in as a parameter rather than
 * inferred. Defaults to `"spawn"` — see `Herd.spawn`'s own doc comment.
 */
export type SpawnOrigin = "spawn" | "respawn";

/** Herd backed by a live herdr, over the typed SDK. */
export class HerdrHerd implements Herd {
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
  ) {}

  private lifecycle(issue: string): ManagedHerdrLifecycle {
    let lifecycle = this.lifecycles.get(issue);
    if (!lifecycle) {
      lifecycle = new ManagedHerdrLifecycle({
        client: this.herdr, cwd: workspaceDirFor(issue),
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

  async recoverQuota(spec: SpawnSpec): Promise<"not-refused" | "recovered" | "waiting"> {
    if (!this.agent.providers && !this.agent.roleProviders) return "not-refused";
    return this.exclusive(spec.key, async () => {
      let current: results.AgentInfo | undefined;
      try { current = await this.lifecycle(spec.key).resolveCurrent(); }
      catch { return "not-refused"; }
      if (!current) { this.refused.delete(spec.key); return "not-refused"; }
      if (current.pane_id !== this.refused.get(spec.key)?.pane || current.agent !== "claude" || current.agent_status === "working") {
        this.refused.delete(spec.key);
      }
      if (current.agent !== "claude" || (current.agent_status !== "idle" && current.agent_status !== "done")) return "not-refused";
      const refusal = this.observeQuota(spec.key, current, await this.readPane(current.pane_id));
      if (!refusal) return "not-refused";
      const result = await this.startProviders(spec, current.pane_id);
      if (result.status === "success") this.log?.(`[provider-fallback] ${spec.key} recovered provider=${result.account.provider} pane=${result.value}`);
      return result.status === "success" ? "recovered" : "waiting";
    });
  }

  private observeQuota(issue: string, current: results.AgentInfo, text: string): SessionLimitRefusal | null {
    // Only Drovr's measured Claude classifier establishes pane quota. No
    // inferred Codex/AGY banners or launch-error strings enter availability.
    if (current.agent !== "claude" || (current.agent_status !== "idle" && current.agent_status !== "done")) return null;
    const refusal = detectSessionLimitRefusal(text, new Date());
    if (!refusal) { this.refused.delete(issue); return null; }
    const previous = this.refused.get(issue);
    // Pin the original reset for this refusal incarnation, otherwise a
    // clock-only banner rolls into tomorrow as soon as its reset passes.
    if (previous?.pane === current.pane_id && previous.refusal.raw === refusal.raw) return previous.refusal;
    const account = { provider: current.agent, accountId: "default" } as const;
    const outcome = this.availability.observeClaudePane(account, current.agent_status, text);
    if (outcome.kind !== "recognised") return null;
    const confirmed = { resetsAt: outcome.resetsAt, raw: outcome.raw };
    this.refused.set(issue, { pane: current.pane_id, provider: account.provider, refusal: confirmed });
    if (this.agent.providers || this.agent.roleProviders) {
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

  async staleIssues(): Promise<StaleAgent[]> {
    // Reconciliation stops stale workers before spawning replacements.
    if (this.agent.provider === "codex" && this.agent.codexSpawnBlocked) return [];
    if (this.agent.provider === "agy" && this.agent.agySpawnBlocked) return [];
    const out: StaleAgent[] = [];
    for (const [issue, { pane, cwd }] of await this.byIssue()) {
      if (this.refused.has(issue)) continue;
      if (!cwd) continue; // no cwd reported — can't build the expected argv — unknown, not stale
      let info: results.PaneProcessInfo | undefined;
      try {
        info = (await this.herdr.pane.processInfo({ pane_id: pane }) as { process_info?: results.PaneProcessInfo }).process_info;
      } catch {
        continue; // herdr hiccup / pane gone — unknown, not stale — and this issue alone, not the whole sweep
      }
      // foreground_processes/argv are both optional/nullable on the wire: a
      // shell still starting, a claude that already exited, or a pane
      // blocked on a dialog can all report none of this — every such gap is
      // UNKNOWN, never stale (a fresh respawn must never itself be
      // respawned every poll — the 7-leaked-workspaces shape, CHANGELOG 0.5.6).
      const proc = info?.foreground_processes?.find((p) => managedAgentProviderOfProcess(p));
      if (!proc?.argv) continue; // no claude in the foreground, or the matched claude reported no argv
      // issuetype/summary/parent don't matter here: --model and --effort
      // (the only things issuetype affects) are both deliberately excluded
      // from the comparison.
      const provider = managedAgentProviderOfProcess(proc)!;
      if (provider === "agy" && this.agent.agySpawnBlocked) continue;
      const disabledMcpServers = this.agent.disabledMcpServers ?? workspaceIsolation(cwd);
      if (provider === "codex" && disabledMcpServers === undefined) {
        out.push({ issue, reason: "Codex MCP isolation inventory missing", observedArgv: proc.argv });
        continue;
      }
      const decoded = decodeAgentKey(issue);
      const expected = spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, ...(decoded ? { resource: decoded.resourceId } : {}) }, cwd, { provider, ...(disabledMcpServers ? { disabledMcpServers } : {}) }, this.mcpUrl);
      const check = checkArgv(expected, proc.argv);
      if (!check.ok) out.push({ issue, reason: check.reason, observedArgv: proc.argv });
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
  async spawn(spec: SpawnSpec, origin: SpawnOrigin = "spawn"): Promise<void> {
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
      this.log?.(`${SPAWN_TAG} ${issue} succeeded — pane ${result.value} origin=${origin}`);
    } catch (e) {
      this.log?.(`${SPAWN_TAG} ${issue} failed origin=${origin} — ${(e as Error)?.message ?? e}`);
      throw e;
    }
  }

  private async startProviders(spec: SpawnSpec, refusedPane?: string) {
    const result = await this.lifecycle(spec.key).start({
      priority: (spec.agents?.length ? [...new Set(spec.agents.map((p) => p.harness))] : providerOrder(this.agent, spec.issuetype)).map(provider => ({ provider, accountId: "default" })),
      label: spec.key,
      ...(refusedPane ? { replacePaneId: refusedPane } : {}),
      kickoff: kickoffFor,
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
        return { launch, ...(home ? { env: { HOME: home }, home } : {}) };
      },
    });
    if (result.status === "success") this.refused.delete(spec.key);
    else {
      if (result.status === "blocked") this.log?.(`[provider-fallback] ${spec.key} blocked: ${result.reason}`);
      const current = await this.lifecycle(spec.key).resolveCurrent();
      if (current?.agent === "claude" && (current.agent_status === "idle" || current.agent_status === "done")) {
        this.observeQuota(spec.key, current, await this.readPane(current.pane_id));
      }
    }
    return result;
  }

  private async readPane(paneId: string): Promise<string> {
    const r = await this.herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true } as Parameters<DrovrClient["pane"]["read"]>[0]);
    return (r as { read: { text: string } }).read.text;
  }

  async stop(issue: string): Promise<void> {
    await this.exclusive(issue, async () => {
      await this.lifecycle(issue).stop();
      this.refused.delete(issue);
    });
  }

  async paneFor(issue: string): Promise<string | null> {
    return (await this.byIssue()).get(issue)?.pane ?? null;
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
        const prompted = await lifecycle.prompt(text);
        if (!prompted || prompted.agent_status === "blocked") return { delivered: false };
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
