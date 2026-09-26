/**
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
import { autoAnswerPermissions, type AutoAnswerPermissionResult, type DrovrClient } from "@brooswit/drovr";

/** The slice of `DrovrClient` `autoAnswerPermissions` actually needs — same shape drovr's own `ApprovalClient` type declares, restated here so this module doesn't need a `DrovrClient` import just to read the pick out of it. */
export type PermissionAnswerClient = { agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys"> };

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
  /** Free-text daemon log line, one per tick that answered/failed anything, plus one per failed/answered pane, named by its `eligiblePanes` label. Optional; omitted, this tick's outcomes are simply never logged (a caller with no daemon console to write to). */
  log?: (line: string) => void;
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
export async function runPermissionAnswerTick(deps: PermissionAnswerLoopDeps): Promise<readonly AutoAnswerPermissionResult[]> {
  const log = deps.log ?? (() => {});
  try {
    const { agents } = await deps.client.agent.list();
    const labels = deps.eligiblePanes(agents.map((a) => ({ pane_id: a.pane_id, cwd: a.cwd })));
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
    const results = await autoAnswerPermissions(scopedClient, {
      auditPath: deps.auditPath,
      ...(deps.operator !== undefined ? { operator: deps.operator } : {}),
      ...(deps.readTimeoutMs !== undefined ? { readTimeoutMs: deps.readTimeoutMs } : {}),
    });
    const label = (paneId: string) => labels.get(paneId) ?? paneId;
    const answered = results.filter((r) => r.outcome === "answered");
    const failed = results.filter((r) => r.outcome === "failed");
    if (answered.length || failed.length) {
      log(`[permission-answer] ${answered.length} answered, ${results.length - answered.length - failed.length} skipped, ${failed.length} failed`);
      for (const a of answered) log(`[permission-answer] ${label(a.paneId)} (${a.paneId}) answered: ${a.tool} — "${a.request.replace(/\n/g, " ").slice(0, 120)}" (see ${deps.auditPath} for the exact stored-rule text)`);
      for (const f of failed) log(`[permission-answer] ${label(f.paneId)} (${f.paneId}) failed: ${f.reason} — ${f.detail}`);
    }
    return results;
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
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runPermissionAnswerTick(deps).finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
