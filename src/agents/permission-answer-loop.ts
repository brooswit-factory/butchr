/**
 * FACTORY-108: also calls `@brooswit/drovr`'s `autoAnswerCodexApprovals`
 * every tick, against the SAME scoped, lizard-eligible pane set — the Codex
 * twin of `autoAnswerPermissions` below (FACTORY-107). Safe to run both
 * unconditionally over one pane set: each is filtered (by screen-content
 * classification for Claude, by `agent.agent === "codex"` internally for
 * Codex — see `scanPendingCodexApprovals`'s own doc comment, `@brooswit/drovr`)
 * to its own vendor's panes, so enabling one can never change the other's
 * behaviour, the same "no double-answerer hazard" property this module's
 * own header already establishes for `chooseStartupAnswer`. A Codex agent
 * only ever shows one of these dialogs when launched with
 * `bypassApprovalsAndSandbox: false` (`SpawnSpec.lizardMode`,
 * src/agents/argv.ts) — Butchr's own launch-flag decision, not this
 * module's — so a Codex pane that never opted into lizard mode shows
 * nothing for `autoAnswerCodexApprovals` to see, matching Claude's own
 * "absent field means today's behaviour exactly" contract.
 *
 * DROVR-42/FACTORY-67 (host-wiring decision carried over from DROVR-41,
 * under the DROVR-37 epic): a standalone interval timer that calls
 * `@brooswit/drovr`'s `autoAnswerPermissions` once per tick — but ONLY
 * across panes eligible for `lizardMode` (`SessionDefinition.lizardMode`/
 * `Rule.lizardMode`, see `ruleLizardModeOf` below for exactly how each
 * resolves), never every pane butchr hosts. The operator's own name for the
 * pairing ("lizard mode") was originally `permissionMode: "default"`
 * (Claude's manual/ask mode, prompting before every tool call) plus this
 * field; FACTORY-138 (operator decision, FACTORY-67 director comment
 * 2026-09-26 22:24Z) made butchr's own launch DEFAULT `acceptEdits` +
 * lizard-eligible together instead, since accept-edits still leaves
 * Bash/MCP tool-permission prompts unanswered — the pairing this field
 * exists for is "any mode that still prompts, plus this field", not manual
 * mode specifically. It presses option 1, "Yes" (allow once — FACTORY-93
 * changed this away from a stored "always allow" rule) on an unambiguous
 * tool-permission dialog ("Do you want to proceed?"), so an agent blocked
 * on one is cleared within one tick instead of sitting frozen for hours
 * until a human happens to notice (the frozen-agent incident this whole
 * epic exists to fix, observed on butchr's own fleet) — without abandoning
 * manual mode's own safety property for every OTHER tool call, for a
 * definition/rule that still chooses manual mode explicitly. A pane whose
 * agent is not eligible (an explicit `lizardMode: false`, since FACTORY-138)
 * is never scanned or touched, by construction (see
 * `runPermissionAnswerTick`'s own doc comment).
 *
 * (An earlier version of this ticket, before FACTORY-67 narrowed the ask,
 * built a blanket sweep over every pane — corrected before merge; see
 * DROVR-42's own ticket history if this module's shape looks surprising
 * next to that ticket's original text.)
 *
 * Deliberately its OWN timer, wired separately from every other poll loop in
 * src/daemon/index.ts (the ~15s Jira reconcile loop, the 5s blocking-
 * escalation watcher `blockingEscalationTimer`, the 5s `watchPrompts`
 * startup-dialog answerer) — a reconcile failure must never stall permission-
 * answering, and a wedged permission-answer tick must never stall reconcile.
 * Same in-flight-guard shape as `blockingEscalationTimer` (never run two
 * ticks concurrently against the same pane set), factored out here as its
 * own small, testable module rather than inlined, so `runPermissionAnswerTick`
 * can be unit-tested against a fake client without a real herdr socket.
 *
 * This does NOT overlap with `chooseStartupAnswer` (src/agents/prompt.ts) —
 * that answerer handles Claude's STARTUP dialogs (trust, bypass-permissions
 * first-run, fullscreen-renderer, settings recommendations); it has no case
 * for the "Do you want to proceed?" tool-permission dialog `autoAnswerPermissions`
 * targets, so there is no double-answerer hazard here the way there was for
 * drovr's escalation watcher (see managed-session-escalation-watcher.ts's own
 * doc comment) — nothing else on this fleet presses that dialog's keys.
 */
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { autoAnswerPermissions, autoAnswerCodexApprovals, type AutoAnswerPermissionResult, type AutoAnswerCodexApprovalResult, type DrovrClient } from "@brooswit/drovr";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import type { Rule } from "../rules/rules.js";

/**
 * FACTORY-145: which path caused a pane's prompt to be looked at THIS tick —
 * `"fast"` when a `pane.agent_status_changed` push frame (`permission-answer-watch.ts`)
 * recorded a trigger instant for this pane that this tick is now consuming,
 * `"sweep"` otherwise (the periodic `agent.list()` scan alone, or
 * `startPermissionAnswerLoop` with no watch wired in at all — every caller
 * with no `fastPathTriggers` map behaves exactly as before this ticket).
 * Deliberately NOT "the fast path is fast" vs "the sweep is slow" — a
 * sweep-triggered answer's true wait is unknowable (see `latencyMs`'s own
 * doc comment on `AnswerLatency`), so this tag exists to let a reader
 * EXCLUDE those answers from a latency computation, not to describe them.
 */
export type PermissionAnswerTrigger = "fast" | "sweep";

/**
 * FACTORY-145: elapsed time from "the fast path learned this pane was
 * blocked" to "this tick pressed its prompt" — computed with a monotonic
 * clock (`deps.now`, default `performance.now`), never wall-clock (which can
 * step). Present ONLY when `trigger` is `"fast"`: a sweep discovers a pane
 * that may have already been sitting blocked anywhere from 0 to one whole
 * sweep interval before the scan happened to look, so "now minus when the
 * sweep looked" is not a latency, it is an artefact that LOOKS like one —
 * emitting it would silently drag a computed p95 downward. Measured from the
 * instant this pane's OWN `blocked` push frame was received
 * (`permission-answer-watch.ts`'s `fastPathTriggers` map) — NOT from
 * whatever instant herdr itself observed the transition, which this frame's
 * own shape (`{ pane_id, agent_status }`, no timestamp — verified against
 * `@brooswit/herdr-sdk`'s own generated `PaneAgentStatusChangedEvent` type,
 * FACTORY-145's own investigation) never carries. So this number excludes
 * whatever time herdr itself took to notice the pane went blocked and get a
 * frame to butchr, plus ordinary network/socket delay ahead of receipt — it
 * is a lower bound on the operator-visible wait, not the whole of it.
 */
export interface AnswerLatency {
  trigger: PermissionAnswerTrigger;
  /** Only present when `trigger` is `"fast"` — see this interface's own doc comment. */
  latencyMs?: number;
}

/** `deps.appendAudit`'s default: the same append-only-file shape `@brooswit/drovr`'s own `defaultDeps.appendAudit` uses (`node_modules/@brooswit/drovr/dist/index.js`), restated here rather than imported since drovr does not export it. */
async function appendAuditLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { mode: 0o600 });
}

/** The slice of `DrovrClient` `autoAnswerPermissions` actually needs — same shape drovr's own `ApprovalClient` type declares, restated here so this module doesn't need a `DrovrClient` import just to read the pick out of it. */
export type PermissionAnswerClient = { agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys"> };

/**
 * FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42) — the pane-
 * eligibility DECISION itself, extracted out of `src/daemon/index.ts`
 * (`lizardModeLabel`) so it is importable by a test rather than only
 * exercisable through the whole daemon module (which has no exports and
 * runs real startup side effects on import). Every input is injected —
 * this module still knows nothing about herdr, `agentIdOfWorkspacePath`, or
 * any daemon-side polling cadence; the caller resolves a pane's `cwd` down
 * to an agent id first (see `ruleLizardModeOf`'s own doc comment) and hands
 * everything else in here.
 */
export interface RuleLizardModeDeps {
  /** Every currently-loaded rule (`src/rules/rules.ts`), read once at daemon startup — matched by `ruleId` + `resourceProvider`, the SAME "rule-level fallback" lookup `ruleRoleOfAgent` (src/daemon/index.ts) already uses for `Rule.role`. */
  rules: readonly Rule[];
  /** Whether `id` belongs to the managed-sessions built-in rule (`ownsManagedSessionAgent`, src/rules/session-definition-type.ts) — injected rather than imported, so this module stays decoupled from that one. */
  isManagedSessionAgent: (id: string) => boolean;
  /** The live, rebuilt-every-poll opt-in map for managed-session agents (`managedSessionLizardModes`, src/daemon/index.ts) — consulted only when `isManagedSessionAgent(id)` is true; a managed-session definition has no static `Rule` of its own to read `lizardMode` off (see `ManagedSessionResourceDeps.lizardModes`'s own doc comment, src/rules/session-definition-type.ts). */
  managedSessionLizardModes: ReadonlyMap<string, boolean>;
}

/**
 * True iff `id`'s agent should be scanned/answered by the permission-answer
 * timer. A managed-session id (`deps.isManagedSessionAgent`) resolves
 * straight from the live `deps.managedSessionLizardModes` map — that map's
 * own fill site (`ManagedSessionResourceDeps.lizardModes`,
 * src/rules/session-definition-type.ts) already folds in FACTORY-138's
 * default (eligible unless explicitly `false`, `vendor: "claude"` only), so
 * this function does no `?? true`/`=== true` translation of its own for that
 * branch — the map's stored value IS the resolved answer. Every OTHER
 * rule-engine agent id (`jira-work`/`jira-project`/`github-issue`/
 * `github-pr`/plain `filesystem`) resolves from that id's own `Rule.lizardMode`,
 * looked up against `deps.rules` — a rule is loaded once at daemon startup
 * (no per-rule live poll the way a managed-session definition file gets
 * one), so there is nothing to rebuild here. FACTORY-138 (operator
 * decision, FACTORY-67 director comment 2026-09-26 22:24Z): a rule that IS
 * found and never sets `lizardMode` is now eligible too — only an explicit
 * `false` opts out — the `!== false` shape below (rather than the old
 * `=== true`) is what flips that default while leaving `id` decoding to
 * nothing, or a rule not found at all (a legacy/bare-issue agent, garbage,
 * or a rule since removed), at `false`: those cases mean "butchr does not
 * own this agent" and must never become eligible no matter which way the
 * field's own default points. A `Rule` has no single fixed vendor (ranked
 * `agentPreferences`, resolved per launch — see `RULE_PERMISSION_MODES`'s
 * own doc comment, src/rules/rules.ts) so this cannot special-case Codex/agy
 * the way the managed-session map above does; unlike `SessionDefinition`'s
 * hard rejection of `lizardMode` for `vendor: "codex"`, `Rule.lizardMode`
 * already applies uniformly to whichever vendor a rule resolves to for an
 * EXPLICIT value (silently inert on a non-Claude pane, since
 * `autoAnswerPermissions`'s dialog recognition is Claude-specific and never
 * matches one — see `docs/permission-answer-loop.md`), so the new default
 * follows that same existing precedent rather than introducing a
 * vendor-awareness this type has never had.
 */
export function ruleLizardModeOf(id: string, deps: RuleLizardModeDeps): boolean {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return false;
  if (deps.isManagedSessionAgent(id)) return deps.managedSessionLizardModes.get(id) === true;
  const rule = deps.rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  if (!rule) return false;
  return rule.lizardMode !== false;
}

/**
 * `id`'s own human label for a `[permission-answer]` journal line (FACTORY-67:
 * name WHICH AGENT, not just an opaque pane id) when it is lizard-mode
 * eligible, else `undefined` — the exact shape `PermissionAnswerLoopDeps.eligiblePanes`
 * needs per pane. A per-resource agent key is labelled by its resource id's
 * basename (an issue key, a GitHub ref, a project key, or a file path,
 * whichever the rule kind uses); a query-level agent (no single resource) or
 * anything `decodeAnyAgentKey` can't split into a resource is labelled by
 * the id itself.
 */
export function lizardModeLabelFor(id: string | null, deps: RuleLizardModeDeps): string | undefined {
  if (!id || !ruleLizardModeOf(id, deps)) return undefined;
  const decoded = decodeAnyAgentKey(id);
  return decoded && decoded.kind === "resource" ? basename(decoded.resourceId) : id;
}

/** The one shape this module needs out of a herdr `agent.list()` row — narrow, so `eligiblePanes` below never needs the full `DrovrClient` agent type. */
export interface PermissionAnswerPane {
  pane_id: string;
  cwd: string | null | undefined;
}

export interface PermissionAnswerLoopDeps {
  client: PermissionAnswerClient;
  /**
   * The eligibility gate (DROVR-42/FACTORY-67 "lizard mode") — called once
   * per tick with every pane herdr currently reports, REGARDLESS of vendor
   * (verified against the daemon's own wiring, src/daemon/index.ts: nothing
   * upstream of this call filters `agent.list()`'s result to Claude panes —
   * a stale claim this doc comment used to make). A Codex/agy pane can
   * therefore end up in the returned map same as a Claude one; scanning one
   * is harmless (`autoAnswerPermissions`'s dialog recognition is
   * Claude-specific and simply never matches its screen, so it is read and
   * ignored, never pressed) — see `ruleLizardModeOf`'s own doc comment
   * (this file) for where FACTORY-138's default deliberately does, or does
   * not, extend to a non-Claude pane's eligibility itself. Return a Map of
   * `pane_id -> a human label` (e.g. the managed-session definition's file
   * name) for exactly the panes eligible this tick; a pane your caller
   * leaves out of the returned map is never scanned or answered by
   * `autoAnswerPermissions` at all — that is the ENTIRE enforcement point
   * for `lizardMode`'s own eligibility contract: it happens once, here,
   * rather than being re-derived downstream. The label exists so a log line
   * can say WHICH AGENT (FACTORY-67's own requirement), not just an opaque
   * pane id — see `runPermissionAnswerTick`'s own doc comment for how it's
   * used.
   */
  eligiblePanes: (agents: readonly PermissionAnswerPane[]) => ReadonlyMap<string, string>;
  /** JSONL audit file — see `Config.permissionAuditPath` (src/config/config.ts) for why this lives under butchr's own state directory rather than drovr's package default. */
  auditPath: string;
  /** Recorded as the audit operator on every attempt. Defaults to drovr's own `"drovr-auto"` when omitted; butchr's daemon wiring (src/daemon/index.ts) passes `"butchr-daemon"` so a shared audit file (or a human comparing hosts) can tell butchr's own unattended pass apart from another caller's. */
  operator?: string;
  /**
   * Deadline for one pane's whole approve attempt — see
   * `AutoAnswerPermissionsOptions.readTimeoutMs`'s own doc comment
   * (`@brooswit/drovr`). Left unset, `autoAnswerPermissions` never times out
   * a pane's attempt on its own; `startPermissionAnswerLoop` below always
   * passes one, set comfortably below its own `intervalMs`, so a wedged pane
   * can never still be in flight when the next tick fires.
   */
  readTimeoutMs?: number;
  /** Free-text daemon log line, one per tick that answered/failed anything, plus one per failed/answered pane, named by its `eligiblePanes` label, plus one per NEWLY skipped pane+reason (FACTORY-93). Optional; omitted, this tick's outcomes are simply never logged (a caller with no daemon console to write to). */
  log?: (line: string) => void;
  /**
   * FACTORY-93: pane+reason keys already logged as skipped, so a prompt that
   * stays unanswerable is logged ONCE (never silently, never every tick).
   * `startPermissionAnswerLoop` owns one for the loop's lifetime; omitted,
   * every skip is logged on every tick.
   */
  loggedSkips?: Set<string>;
  /** Test seam: the drovr pass to run. Defaults to `@brooswit/drovr`'s own `autoAnswerPermissions`. */
  autoAnswer?: typeof autoAnswerPermissions;
  /** FACTORY-108: same test seam as `autoAnswer` above, for Codex. Defaults to `@brooswit/drovr`'s own `autoAnswerCodexApprovals`. */
  autoAnswerCodex?: typeof autoAnswerCodexApprovals;
  /**
   * FACTORY-100/FACTORY-103: called once per newly-answered pane, purely as
   * a side effect — see `src/agents/approval-sound.ts`'s own doc comment for
   * why the "sound plays on approval" hook lives here rather than tailing
   * drovr's audit file. NEVER awaited and NEVER allowed to affect this
   * tick's own outcome: `createApprovalSoundNotifier`'s `notifyApproved`
   * already catches everything internally, and the call site below wraps it
   * again regardless, so a caller-supplied callback that throws synchronously
   * still cannot fail an approval. Optional; omitted, nothing plays.
   */
  onApproved?: () => void;
  /**
   * FACTORY-581 SAFETY GUARD 3: called once per ANSWERED Claude result this
   * tick (never for Codex — `AutoAnswerCodexApprovalResult`'s `answered`
   * variant carries `kind`, not `recognizedVia`; no managed session runs
   * Codex today — `ruleLizardModeOf`'s own doc comment — so there is no
   * attributable case to cover there yet), with the exact `paneId` and
   * `recognizedVia` drovr returned. Lets a caller (the daemon's own
   * `escalator.onPermissionAnswered`, src/daemon/index.ts) attribute a
   * managed-session pane's "no longer blocked" line to THIS pass — distinct
   * from an escalated dialog's own resolution — using drovr's own
   * classification rather than a tag invented here. Same
   * "never awaited, never allowed to affect this tick's own outcome"
   * contract as `onApproved` immediately above, and called for EVERY
   * answered pane (not only managed sessions): the callback is expected to
   * no-op cheaply for anything it doesn't track.
   */
  onAnswered?: (result: { paneId: string; recognizedVia: string }) => void;
  /**
   * FACTORY-98: called once per tick with the pane ids `eligiblePanes`
   * returned THIS tick — before any screen is scanned or pressed, and even
   * when the set is empty. Lets a caller (`permission-answer-watch.ts`'s
   * event-driven fast path) keep a herdr push subscription's pane-id filter
   * in sync with the exact same `agent.list()` call this tick already makes,
   * instead of polling a second one just to notice the set changed. Optional;
   * omitted, nothing extra happens.
   */
  onEligiblePaneIds?: (paneIds: readonly string[]) => void;
  /**
   * FACTORY-145: `pane_id -> the monotonic instant (per `deps.now`) its own
   * `blocked` push frame was received` — owned and populated by
   * `permission-answer-watch.ts`'s fast path, read (and consumed: deleted)
   * here for every pane this tick scanned, whether or not it ended up
   * `answered`. Absent entirely for a bare `startPermissionAnswerLoop` with
   * no watch wired in — every such caller's answers are `trigger: "sweep"`
   * with no `latencyMs`, unchanged from before this ticket. Consuming a
   * pane's entry on every scan (not only on `answered`) matters: a `skipped`
   * or `failed` outcome leaves the pane still blocked, and a STALE trigger
   * instant left in the map would silently understate a LATER tick's real
   * latency for the same pane once it does get answered.
   */
  fastPathTriggers?: Map<string, number>;
  /**
   * Monotonic clock (never wall-clock — see `AnswerLatency`'s own doc
   * comment for why) used both to record a fast-path trigger instant
   * (`permission-answer-watch.ts`) and to compute `latencyMs` here. Test
   * seam; defaults to the real `performance.now`. The SAME function must be
   * used by both call sites for a latency number to mean anything — sharing
   * one `deps` object (as `PermissionAnswerWatchDeps extends
   * PermissionAnswerLoopDeps` already does) is what guarantees that.
   */
  now?: () => number;
  /** Test seam: how a latency audit line is appended. Defaults to the real filesystem (`mkdir` + `appendFile`, same shape as `@brooswit/drovr`'s own `defaultDeps.appendAudit`). */
  appendAudit?: (path: string, line: string) => Promise<void>;
}

/**
 * One pass over the CURRENTLY-eligible panes only — never a blanket
 * fleet sweep (see this module's own header): reads the live pane list
 * once, asks `deps.eligiblePanes` which of them are eligible this tick, and
 * (if any are) hands `autoAnswerPermissions` a client scoped to exactly that
 * fixed set — scan for a pending tool-permission dialog, press the
 * unambiguous option 1, "Yes" (allow once — FACTORY-93; NOT a stored
 * "always allow" rule), log one line per pane touched plus a
 * one-line summary naming each answered/failed pane's `eligiblePanes` label
 * (FACTORY-67: "logged with agent, tool, ... visible somewhere an operator
 * actually looks" — the exact stored-rule text pressed is not returned by
 * `autoAnswerPermissions` itself; see `deps.auditPath`, which drovr's own
 * `approvePermission` writes it to, for that literal text — this module
 * deliberately never re-parses a pane's screen itself to recover it, since
 * dialog recognition is drovr's job, not butchr's, per FACTORY-49/FACTORY-67).
 * A tick with nothing eligible costs exactly one `agent.list()` call and
 * nothing else — no scan, no read, no log line — which is what makes an
 * explicit `lizardMode: false` cost nothing beyond that one call, down to
 * the herdr call count, not merely the observable outcome.
 *
 * Never throws — a rejecting `agent.list()` or `autoAnswerPermissions` call
 * (the scan itself failing, not a single pane's attempt, which
 * `autoAnswerPermissions` already isolates into a `failed` result per pane)
 * is caught and logged instead, so one bad tick can never take the timer
 * down — same "isolated poll" discipline every other daemon timer in this
 * file's sibling module (`blockingEscalationTimer`, src/daemon/index.ts)
 * already follows.
 */
export async function runPermissionAnswerTick(deps: PermissionAnswerLoopDeps): Promise<readonly (AutoAnswerPermissionResult | AutoAnswerCodexApprovalResult)[]> {
  const log = deps.log ?? (() => {});
  try {
    const { agents } = await deps.client.agent.list();
    const labels = deps.eligiblePanes(agents.map((a) => ({ pane_id: a.pane_id, cwd: a.cwd })));
    deps.onEligiblePaneIds?.([...labels.keys()]);
    // FACTORY-776 (a): reap every fastPathTriggers entry for a pane that is
    // NOT in this tick's eligible set — above the `labels.size === 0` early
    // return below (so an empty eligible set still reaps) and unconditional
    // on outcome, so a pane that left the eligible set (its own entry is
    // never otherwise visited: the consumption loop further down only walks
    // `labels.keys()`) cannot keep re-tripping the watchdog forever. A pane
    // that IS still eligible keeps its entry here — that case is handled by
    // the consumption loop below, which runs regardless of this tick's
    // answered/skipped/failed outcome.
    if (deps.fastPathTriggers) {
      for (const id of deps.fastPathTriggers.keys()) {
        if (!labels.has(id)) deps.fastPathTriggers.delete(id);
      }
    }
    if (labels.size === 0) return [];
    const eligible = agents.filter((a) => labels.has(a.pane_id));
    const scopedClient: PermissionAnswerClient = {
      agent: {
        list: async () => ({ type: "agent_list", agents: eligible }),
        get: deps.client.agent.get,
        read: deps.client.agent.read,
        sendKeys: deps.client.agent.sendKeys,
      },
    };
    // FACTORY-93 (operator direction): always press option 1 "Yes" (allow
    // once). Matching Claude's "always allow" wording was fragile — the
    // read-permission dialog says "Yes, allow reading …" and was skipped.
    //
    // FACTORY-108 (review): the Claude and Codex passes run CONCURRENTLY,
    // not sequentially — each is independently bounded by `readTimeoutMs`
    // (8s), and `startPermissionAnswerLoop`/`startPermissionAnswerWatch`
    // both assume one tick fits comfortably inside the 20s sweep interval
    // (see `PermissionAnswerLoopDeps.readTimeoutMs`'s own doc comment). Two
    // SEQUENTIAL 8s-bounded passes could together approach 16s, eating most
    // of that margin; running them concurrently keeps one tick's total
    // bound at ~8s, same as before this ticket, since the two passes touch
    // disjoint panes internally (Claude's own `classifyPermissionPrompt`
    // never matches a Codex pane's screen and vice versa — see this
    // module's own header) and so share nothing to race over except
    // `deps.auditPath`, which drovr's own `approvePermission`/
    // `approveCodexApproval` already append to safely under concurrent
    // callers (the SAME file `autoAnswerPermissions` itself already writes
    // to from multiple panes' concurrent reads within one pass).
    const [results, codexResults] = await Promise.all([
      (deps.autoAnswer ?? autoAnswerPermissions)(scopedClient, {
        scope: "once",
        auditPath: deps.auditPath,
        ...(deps.operator !== undefined ? { operator: deps.operator } : {}),
        ...(deps.readTimeoutMs !== undefined ? { readTimeoutMs: deps.readTimeoutMs } : {}),
      }),
      // FACTORY-108: Codex lizard mode — same scoped, eligible pane set as
      // the Claude pass; `autoAnswerCodexApprovals` internally filters to
      // `agent.agent === "codex"` panes only, so this is a pure no-op
      // whenever nothing eligible this tick happens to be a Codex pane.
      (deps.autoAnswerCodex ?? autoAnswerCodexApprovals)(scopedClient, {
        auditPath: deps.auditPath,
        ...(deps.operator !== undefined ? { operator: deps.operator } : {}),
        ...(deps.readTimeoutMs !== undefined ? { readTimeoutMs: deps.readTimeoutMs } : {}),
      }),
    ]);
    const label = (paneId: string) => labels.get(paneId) ?? paneId;
    const now = deps.now ?? (() => performance.now());
    // FACTORY-145: consume (read, then delete) every scanned pane's own
    // fast-path trigger instant, whether or not it ends up `answered` — see
    // `fastPathTriggers`'s own doc comment on `PermissionAnswerLoopDeps` for
    // why a `skipped`/`failed` outcome must not leave a stale one behind.
    const triggeredAt = new Map<string, number>();
    if (deps.fastPathTriggers) {
      for (const id of labels.keys()) {
        const t = deps.fastPathTriggers.get(id);
        if (t !== undefined) {
          triggeredAt.set(id, t);
          deps.fastPathTriggers.delete(id);
        }
      }
    }
    const latencyOf = (paneId: string): AnswerLatency => {
      const t = triggeredAt.get(paneId);
      return t === undefined ? { trigger: "sweep" } : { trigger: "fast", latencyMs: Math.max(0, Math.round(now() - t)) };
    };
    const answered = results.filter((r) => r.outcome === "answered");
    const failed = results.filter((r) => r.outcome === "failed");
    if (answered.length || failed.length) {
      log(`[permission-answer] ${answered.length} answered, ${results.length - answered.length - failed.length} skipped, ${failed.length} failed`);
      for (const a of answered) {
        const { trigger, latencyMs } = latencyOf(a.paneId);
        const latencySuffix = latencyMs !== undefined ? `, ${trigger}, ${latencyMs}ms` : `, ${trigger}`;
        log(`[permission-answer] ${label(a.paneId)} (${a.paneId}) answered: ${a.tool} — "${a.request.replace(/\n/g, " ").slice(0, 120)}"${latencySuffix} (see ${deps.auditPath})`);
        const auditLine = JSON.stringify({
          ts: new Date().toISOString(),
          paneId: a.paneId,
          label: label(a.paneId),
          tool: a.tool,
          request: a.request.slice(0, 500),
          trigger,
          ...(latencyMs !== undefined ? { latencyMs } : {}),
        }) + "\n";
        try {
          await (deps.appendAudit ?? appendAuditLine)(deps.auditPath, auditLine);
        } catch (e) {
          log(`[permission-answer] latency audit write failed for ${a.paneId}: ${(e as Error)?.message ?? e}`);
        }
        try { deps.onApproved?.(); } catch { /* FACTORY-100/FACTORY-103: a sound-notification failure must never affect this tick's own outcome */ }
        try { deps.onAnswered?.({ paneId: a.paneId, recognizedVia: a.recognizedVia }); } catch { /* FACTORY-581 GUARD 3: same contract as onApproved above — never affects this tick's own outcome */ }
      }
      for (const f of failed) log(`[permission-answer] ${label(f.paneId)} (${f.paneId}) failed: ${f.reason} — ${f.detail}`);
    }
    for (const r of results) {
      if (r.outcome !== "skipped") continue;
      const key = `${r.paneId}\u0000${r.reason}`;
      if (deps.loggedSkips?.has(key)) continue;
      deps.loggedSkips?.add(key);
      log(`[permission-answer] ${label(r.paneId)} (${r.paneId}) SKIPPED, left for a human: ${r.reason}`);
    }
    const codexAnswered = codexResults.filter((r) => r.outcome === "answered");
    const codexFailed = codexResults.filter((r) => r.outcome === "failed");
    const codexUnrecognised = codexResults.filter((r) => r.outcome === "unrecognised");
    const codexSkipped = codexResults.filter((r) => r.outcome === "skipped");
    if (codexAnswered.length || codexFailed.length || codexUnrecognised.length) {
      log(`[permission-answer] codex: ${codexAnswered.length} answered, ${codexSkipped.length} skipped, ${codexUnrecognised.length} unrecognised, ${codexFailed.length} failed`);
      for (const a of codexAnswered) log(`[permission-answer] ${label(a.paneId)} (${a.paneId}) answered (codex): ${a.kind} — "${a.detail.replace(/\n/g, " ").slice(0, 120)}" (see ${deps.auditPath})`);
      for (const f of codexFailed) log(`[permission-answer] ${label(f.paneId)} (${f.paneId}) failed (codex): ${f.reason} — ${f.detail}`);
    }
    for (const r of codexResults) {
      if (r.outcome === "answered" || r.outcome === "failed") continue;
      const unrecognised = r.outcome === "unrecognised";
      // FACTORY-107/FACTORY-108 (review): an approval-shaped Codex screen
      // this module can't parse is loud, not invisible — never folded into
      // "skipped" and never silently dropped — but still deduped per
      // pane+reason (same FACTORY-93 discipline `skipped` already gets) so a
      // persistently unrecognised pane doesn't flood the journal every tick.
      // The dedup key for "unrecognised" includes the EXCERPT itself, not
      // just the literal string "unrecognised": a pane stuck on the SAME
      // unrecognised screen logs once, but a DIFFERENT unrecognised dialog
      // appearing later on that same pane is a new, distinct thing a human
      // has not yet seen — it must log again, not be swallowed by the first
      // dialog's already-seen key.
      const key = "codex " + r.paneId + " " + (unrecognised ? "unrecognised:" + r.excerpt : r.reason);
      if (deps.loggedSkips?.has(key)) continue;
      deps.loggedSkips?.add(key);
      log(unrecognised
        ? `[permission-answer] ${label(r.paneId)} (${r.paneId}) UNRECOGNISED (codex), left for a human: ${r.excerpt.replace(/\n/g, " ").slice(0, 200)}`
        : `[permission-answer] ${label(r.paneId)} (${r.paneId}) SKIPPED (codex), left for a human: ${r.reason}`);
    }

    if (deps.loggedSkips && deps.loggedSkips.size > 1000) deps.loggedSkips.clear();
    return [...results, ...codexResults];
  } catch (e) {
    log(`[permission-answer] tick failed: ${(e as Error)?.message ?? e}`);
    return [];
  }
}

/**
 * Wires `runPermissionAnswerTick` onto its own `setInterval`, guarded so two
 * ticks never run concurrently (a slow tick — many eligible panes, a
 * near-deadline approve attempt — simply skips the next firing rather than
 * overlapping it), same shape as `blockingEscalationTimer`
 * (src/daemon/index.ts). `.unref()`'d before returning, same as every other
 * background timer in this codebase, so it can never keep the process alive
 * on its own.
 */
export function startPermissionAnswerLoop(deps: PermissionAnswerLoopDeps, intervalMs: number): ReturnType<typeof setInterval> {
  let inFlight = false;
  deps = { ...deps, loggedSkips: deps.loggedSkips ?? new Set<string>() };
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runPermissionAnswerTick(deps).finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
