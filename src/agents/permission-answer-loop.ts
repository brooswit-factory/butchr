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
 * across panes whose managed-session definition opted in with
 * `lizardMode: true` (`SessionDefinition.lizardMode`,
 * src/resources/session-definition.ts), never every Claude pane butchr
 * hosts. The operator's own name for the combination ("lizard mode") is
 * `permissionMode: "default"` (Claude's manual/ask mode, prompting before
 * every tool call) plus this field: it presses the "always allow"
 * stored-rule option on an unambiguous tool-permission dialog ("Do you want
 * to proceed?"), so an agent blocked on one is cleared within one tick
 * instead of sitting frozen for hours until a human happens to notice (the
 * frozen-agent incident this whole epic exists to fix, observed on butchr's
 * own fleet) — without abandoning manual mode's own safety property for
 * every OTHER tool call. A pane whose agent never opted in is never scanned
 * or touched, by construction (see `runPermissionAnswerTick`'s own doc
 * comment) — matching `lizardMode`'s "absent means today's behaviour
 * exactly" contract.
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
import { basename } from "node:path";
import { autoAnswerPermissions, autoAnswerCodexApprovals, type AutoAnswerPermissionResult, type AutoAnswerCodexApprovalResult, type DrovrClient } from "@brooswit/drovr";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import type { Rule } from "../rules/rules.js";

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
 * True iff `id`'s agent has opted into "lizard mode". A managed-session id
 * (`deps.isManagedSessionAgent`) resolves from the live
 * `deps.managedSessionLizardModes` map exactly as before FACTORY-87; every
 * OTHER rule-engine agent id (`jira-work`/`jira-project`/`github-issue`/
 * `github-pr`/plain `filesystem`) resolves from that id's own `Rule.lizardMode`,
 * looked up against `deps.rules` — a rule is loaded once at daemon startup
 * (no per-rule live poll the way a managed-session definition file gets
 * one), so there is nothing to rebuild here. `id` decoding to nothing (a
 * legacy/bare-issue agent, or garbage) resolves `false`, matching
 * `lizardMode`'s own "absent means never touched" contract.
 */
export function ruleLizardModeOf(id: string, deps: RuleLizardModeDeps): boolean {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return false;
  if (deps.isManagedSessionAgent(id)) return deps.managedSessionLizardModes.get(id) === true;
  const rule = deps.rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.lizardMode === true;
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
   * The opt-in gate (DROVR-42/FACTORY-67 "lizard mode") — called once per
   * tick with every Claude pane herdr currently reports. Return a Map of
   * `pane_id -> a human label` (e.g. the managed-session definition's file
   * name) for exactly the panes eligible this tick; a pane your caller
   * leaves out of the returned map is never scanned or answered by
   * `autoAnswerPermissions` — that is the ENTIRE enforcement point for
   * "absent field means today's behaviour exactly" (`lizardMode`'s own
   * contract): it happens once, here, rather than being re-derived
   * downstream. The label exists so a log line can say WHICH AGENT
   * (FACTORY-67's own requirement), not just an opaque pane id — see
   * `runPermissionAnswerTick`'s own doc comment for how it's used.
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
   * FACTORY-98: called once per tick with the pane ids `eligiblePanes`
   * returned THIS tick — before any screen is scanned or pressed, and even
   * when the set is empty. Lets a caller (`permission-answer-watch.ts`'s
   * event-driven fast path) keep a herdr push subscription's pane-id filter
   * in sync with the exact same `agent.list()` call this tick already makes,
   * instead of polling a second one just to notice the set changed. Optional;
   * omitted, nothing extra happens.
   */
  onEligiblePaneIds?: (paneIds: readonly string[]) => void;
}

/**
 * One pass over the CURRENTLY-eligible Claude panes only — never a blanket
 * fleet sweep (see this module's own header): reads the live pane list
 * once, asks `deps.eligiblePanes` which of them opted in this tick, and (if
 * any did) hands `autoAnswerPermissions` a client scoped to exactly that
 * fixed set — scan for a pending tool-permission dialog, press the
 * unambiguous "always allow" option, log one line per pane touched plus a
 * one-line summary naming each answered/failed pane's `eligiblePanes` label
 * (FACTORY-67: "logged with agent, tool, ... visible somewhere an operator
 * actually looks" — the exact stored-rule text pressed is not returned by
 * `autoAnswerPermissions` itself; see `deps.auditPath`, which drovr's own
 * `approvePermission` writes it to, for that literal text — this module
 * deliberately never re-parses a pane's screen itself to recover it, since
 * dialog recognition is drovr's job, not butchr's, per FACTORY-49/FACTORY-67).
 * A tick with nothing eligible costs exactly one `agent.list()` call and
 * nothing else — no scan, no read, no log line — which is what makes
 * "absent field means today's behaviour exactly" true down to the herdr
 * call count, not merely the observable outcome.
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
    const answered = results.filter((r) => r.outcome === "answered");
    const failed = results.filter((r) => r.outcome === "failed");
    if (answered.length || failed.length) {
      log(`[permission-answer] ${answered.length} answered, ${results.length - answered.length - failed.length} skipped, ${failed.length} failed`);
      for (const a of answered) {
        log(`[permission-answer] ${label(a.paneId)} (${a.paneId}) answered: ${a.tool} — "${a.request.replace(/\n/g, " ").slice(0, 120)}" (see ${deps.auditPath})`);
        try { deps.onApproved?.(); } catch { /* FACTORY-100/FACTORY-103: a sound-notification failure must never affect this tick's own outcome */ }
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
