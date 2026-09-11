import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";
import { unseenIds } from "../resources/project.js";

/**
 * BUTCHR-307 — the issue tier's sleep/wake registry, the mechanism behind the
 * `stand_down` verb (src/tools/defs.ts). In-memory daemon state only, never
 * persisted — losing it on a restart is SAFE and self-healing: every active
 * issue is simply desired again and spawns, bounded by the admission cap
 * (BUTCHR-284). The only window where an edge can be lost this way is one
 * where the restart itself already wakes the agent anyway.
 *
 * WHY THIS IS NOT A PERSISTED WATERMARK, UNLIKE THE PROJECT TIER'S: the
 * project tier's wake signal (src/resources/project.ts) is a durable STATE
 * COMPARISON — root-doc version, comment id sets, epics in review — so it
 * needs durable storage to survive a restart. The issue tier already has a
 * complete, exercised EDGE detector for "does this issue's agent need to
 * hear about this": the notify stage (`runResourceLoop`'s `onChange` ->
 * `eventRules.poll` -> `decide` -> `deps.notify`, src/daemon/loop.ts and
 * src/resources/issue.ts) and its suppression stack. This registry reuses
 * that edge detector rather than building a second one — see
 * `createIssueEventRules`'s `decide()` for where a `deliver: true` verdict is
 * gated through `unseenFor`/`wake` below before it is allowed to actually
 * wake a sleeping watcher.
 *
 * THE SELF-WAKE HAZARD, AND WHY AN EDGE ALONE IS NOT ENOUGH: a boss's normal
 * ending is `report_to_boss` (a comment on its own ticket) and/or
 * `tell_worker` (a comment on a worker's), then `stand_down` — every one of
 * those is a change the notify stage would otherwise turn into an edge.
 * MEASURED LIVE on this ticket's own thread (BUTCHR-307's Jira history,
 * 2026-09-10 ~18:52): a `tell_worker` write was echoed back to its own
 * author as a delivered, wake-worthy edge, because a FOREIGN write (a daemon
 * label sync this agent's own write ledger had no entry for — bosses and
 * workers sit on different accounts by construction here, so this is the
 * NORM, not bad luck) landed inside the same poll window and pushed
 * `updated` strictly past the own-write ledger's recorded value. The ledger
 * (src/jira-watch/own-writes.ts) keys suppression on an EXACT `updated`
 * match; a foreign write in the same window makes that match fail, so
 * suppression correctly declines — the ledger's own doc calls this out as
 * "by construction". For an ordinary NUDGE that is free: the pane is already
 * up, one extra prompt costs nothing. For a WAKE it is a spurious spawn
 * after every normal ending, because after this ticket a suppression
 * decision no longer decides whether a nudge lands — it decides whether an
 * AGENT EXISTS. Comment AUTHORSHIP cannot discriminate either: every agent
 * on one account writes as the same Atlassian account, so authorship
 * distinguishes accounts, not agents.
 *
 * THE FIX: `standDown()` snapshots, once, the set of comment ids present on
 * every ticket the caller watches (its own ticket and its current workers)
 * at the exact moment it stands down. A later notify edge whose only
 * evidence is "the newest comment might have moved" (see `decide()`'s
 * `reason: undefined` and `{ comment: true }` cases — the two shapes a
 * self-authored comment can produce) is compared against that snapshot by
 * SET MEMBERSHIP ONLY — no ordering, no magnitude, no `Number()`. This reuses
 * `unseenIds` from src/resources/project.ts (BUTCHR-227's own hard rule and
 * its implementation) rather than re-implementing the comparison: two
 * independent implementations of "is this id new" would drift, and the one
 * that drifts silently is the one deciding whether an agent exists. A
 * STRUCTURAL edge (appeared/disappeared/a status, daemon-label, or pr:*
 * transition, a summary edit) always wakes unconditionally — none of those
 * is a shape `stand_down`'s own last-act writes (comments) can produce, so
 * they need no seen-set check; see `createIssueEventRules`'s `decide()` for
 * where that split is made.
 *
 * THE SEEN-SET IS BOUNDED, STATED EXPLICITLY (epic review condition):
 * `standDown()` is called at most once per sleep episode (a fresh call
 * replaces, never accumulates, the prior record for that id), and each
 * watched ticket contributes at most `AtlassianClient.comments`'s own
 * `maxResults` cap (20, src/atlassian/client.ts) comment ids. So one
 * episode's seen-set is bounded by `20 * (1 + number of the caller's current
 * workers)` — small in practice, and it cannot grow further while asleep: a
 * standing episode never re-snapshots. `forgetMissing` (called every poll
 * from `createIssueResourceType`'s `discovery.search()`, src/resources/
 * issue.ts) drops the whole record the moment the ticket leaves the active
 * JQL result set, so memory is bounded by "currently active issues that have
 * ever stood down", not by the daemon's total lifetime population.
 *
 * TWO NEW FAILURE MODES THIS MECHANISM CREATES, BOTH BOUNDED HERE:
 *
 * - LOST WAKE: a missed or wrongly-suppressed edge would otherwise leave a
 *   ticket In Progress, with no agent, silently, forever — worse than the
 *   defect this ticket fixes. `tickMaxSleep`, called once per poll per
 *   currently-tracked id (from `discovery.search()`), force-wakes (reason
 *   `"bound"`) an issue that has been asleep continuously past
 *   `BUTCHR_STANDDOWN_MAX_MINUTES` (src/config/config.ts, same shape as
 *   `BUTCHR_ATREST_MINUTES`). A wake-by-bound is logged distinctly from a
 *   wake-by-edge (see `wake`'s own log line) — an operator seeing one in the
 *   journal knows an edge was likely missed, not that this is routine.
 * - YIELD LOOP: a bug (a spurious edge source, a `stand_down` that fires
 *   with something still unhandled, a wake that re-triggers on its own side
 *   effects) could in principle produce wake -> stand_down -> wake ->
 *   stand_down indefinitely. This is DELIBERATELY invisible to the
 *   crash-loop detector (src/agents/crash-loop.ts) — see
 *   `consumeCrashLoopExemptions`'s own doc comment for why that exemption is
 *   correct and what it costs — so this registry counts EDGE wakes (never
 *   bound wakes, which are not a loop symptom) per id in a rolling window
 *   and posts its own `[butchr:yieldloop]` complaint, distinct from
 *   crash-loop's `[butchr:crashloop]`: a different fault (an agent that
 *   keeps legitimately waking and immediately yielding again) with a
 *   different remedy (fix the wake predicate or the agent's own briefs, not
 *   "why does this process keep dying").
 *
 * WHY THE PANE-RELEASE SIGNAL IS SEPARATE FROM SLEEP ITSELF:
 * `consumeCrashLoopExemptions` aside, this registry does NOT itself stop any
 * agent's pane — `stand_down`'s tool handler (src/tools/defs.ts) also calls
 * a second, independent registry, a dedicated `CheckInExitRegistry`
 * (src/agents/check-in-exit.ts) instance for the issue loop, reused
 * unmodified from the project tier's own exit mechanism. That is what
 * actually releases the pane through the daemon's existing `plan.stop` ->
 * `herd.stop()` route. This module only ever answers "is this id asleep, and
 * has anything happened it has not seen" — it carries no pane, no herd, no
 * Jira write of its own beyond the audible complaints above.
 */

/** Marker every yield-loop complaint this module writes starts with — distinct from crash-loop.ts's `[butchr:crashloop]`, a different fault with a different remedy. */
export const YIELD_LOOP_MARKER = "[butchr:yieldloop]";

/** Mirrors every other detector's per-target escalation budget: at most this many complaints per resource per rolling hour. */
const MAX_PER_HOUR = 3;

/** The dedupe/adoption key embedded in `yieldLoopComment`'s last line — bracket-delimited so `findMarked`'s substring match can never false-match a longer id sharing this one as a prefix (same reasoning as crash-loop.ts's `resourceKey`). */
function resourceKey(id: string): string {
  return `resource: [${id}]`;
}

function yieldLoopComment(id: string, count: number, windowMinutes: number): string {
  return [
    `${YIELD_LOOP_MARKER} ${id} has woken from stand_down ${count} times in the last ${windowMinutes} minutes.`,
    "",
    `This is a different fault from a crash loop: nothing is dying — ${id}'s agent keeps waking, apparently for a real reason, and immediately standing down again. Likely causes: a wake predicate that is too eager (something looks new but is not, to a reader who has already handled it), or a stand_down called while something is still genuinely unhandled. A human should look at why the wake/stand_down cycle keeps repeating rather than waiting for it to stop unattended.`,
    "",
    resourceKey(id),
  ].join("\n");
}

/** One issue's sleep record: the comment ids it had already seen, per watched ticket, at the moment it stood down, plus when. */
interface SleepEntry {
  seen: ReadonlyMap<string, ReadonlySet<string>>;
  sleptAt: number;
}

export type WakeReason = "edge" | "bound";

export interface StandDownDeps {
  now: () => number;
  /** BUTCHR_STANDDOWN_MAX_MINUTES — the maximum minutes an issue may stay asleep before being force-woken as a lost-wake rescue. */
  maxSleepMinutes: number;
  /** BUTCHR_YIELDLOOP_COUNT — edge-wakes of the same id within the rolling window before the yield-loop complaint fires. */
  yieldLoopCount: number;
  /** BUTCHR_YIELDLOOP_WINDOW_MINUTES — the yield-loop rolling window, in minutes. */
  yieldLoopWindowMinutes: number;
  /** Post through the issue's own ticket — see src/tools/speak.ts's speakOnOwnChannel; never a second Atlassian writer. */
  addComment: (id: string, text: string) => Promise<void>;
  /** Recent comments on the issue's own ticket, newest-first is fine — same contract as every other detector's `comments` dep. */
  comments: (id: string) => Promise<readonly CommentRow[]>;
  log?: (line: string) => void;
}

export interface StandDownRegistry {
  /**
   * Declare `id` asleep, snapshotting `seen` (ticket key -> every comment id
   * currently on it) as the baseline every later edge is compared against.
   * A fresh call REPLACES any prior record for `id` — each call starts a new
   * sleep episode, never accumulates onto an old one.
   */
  standDown(id: string, seen: ReadonlyMap<string, readonly string[]>): void;
  /** Pure, synchronous: is `id` currently asleep? Read by `ISSUE_ACTIVATION.verdictFor` (src/resources/issue.ts) via the snapshot `discovery.search()` stamps — never consulted from inside `verdictFor` itself in a way that would make it impure; the flag is baked onto `T` once per poll instead. */
  isAsleep(id: string): boolean;
  /** Whether `id` has a recorded seen-set for `key` specifically — false for a ticket that was not among `id`'s watched tickets at stand-down (e.g. a worker created afterward). A caller must fail TOWARD waking on false, never treat "no baseline" as "nothing new" (mirrors this codebase's other baseline-absence conventions — see src/resources/issue.ts's own `commentCursor` doc comment). */
  hasBaseline(id: string, key: string): boolean;
  /** Set-membership only (BUTCHR-227's rule, reused via `unseenIds` — not re-implemented here): ids in `observed` not already recorded as seen for (id, key). Empty when `id` is not asleep, or has no baseline for `key` (see `hasBaseline`) — a caller must check `hasBaseline` first when the empty-vs-nothing-to-compare distinction matters. */
  unseenFor(id: string, key: string, observed: readonly string[]): readonly string[];
  /**
   * Wake `id`: clears its sleep record, marks it exempt from the very next
   * crash-loop check that observes it spawning (see
   * `consumeCrashLoopExemptions`), and logs a greppable, reason-tagged line.
   * `reason: "edge"` additionally counts toward the yield-loop window and
   * may post an audible `[butchr:yieldloop]` complaint; `reason: "bound"`
   * never does (a lost-wake rescue is not a loop symptom). No-op beyond the
   * log line if `id` was not asleep. Never throws.
   */
  wake(id: string, reason: WakeReason): Promise<void>;
  /**
   * Called once per poll, per currently-tracked id (from `discovery.search()`
   * — see this module's own top comment on the lost-wake bound). If `id` is
   * asleep and has been continuously since before `now - maxSleepMinutes`,
   * force-wakes it (`reason: "bound"`) and returns true. No-op, returns
   * false, otherwise. Never throws.
   */
  tickMaxSleep(id: string): Promise<boolean>;
  /** Drop every sleep/crash-loop-exemption record for an id not in `stillPresent` this poll — bounds memory to currently-active issues (see this module's own top comment on the seen-set bound). */
  forgetMissing(stillPresent: ReadonlySet<string>): void;
  /**
   * Returns `admitted` with any id whose most recent wake is still an
   * unconsumed exemption removed, clearing that exemption for each id
   * removed. Wired at the daemon's crash-loop call site
   * (src/daemon/index.ts), wrapping `issueCrashLoopDetector.check` — see
   * this module's own top comment for why a wake-driven spawn must never
   * reach that detector's candidate list: `stand_down` is an ORDERLY exit
   * and a subsequent wake-driven spawn is a positive declaration, not an
   * undeclared crash, so the detector's own definition ("unexplained
   * re-spawns") is correctly never shown this category of event at all —
   * the crash-loop detector's own source is untouched by this ticket.
   * The exemption persists across polls until the id is ACTUALLY admitted
   * (an admission-cap withhold does not consume it) — never expires on a
   * timer, since a withheld candidate has not yet had the spawn this
   * exemption is for.
   */
  consumeCrashLoopExemptions(admitted: readonly string[]): readonly string[];
}

export function createStandDownRegistry(deps: StandDownDeps): StandDownRegistry {
  const asleep = new Map<string, SleepEntry>();
  const crashLoopExempt = new Set<string>();
  // Yield-loop bookkeeping — same shape as crash-loop.ts's CrashLoopTracker,
  // deliberately not reused directly: that tracker's `forgetMissing` prunes
  // on `desired` (a concept this registry doesn't have), and its own
  // "already spoken" latch is cleared by the SAME event; here the window
  // emptying out (no PRIOR wake still inside it, checked before this poll's
  // own wake is added — see recordEdgeWake) IS the signal a cluster ended,
  // so the latch is dropped at that point, letting a later, genuinely new
  // cluster for the same id complain again (subject to `findMarked`'s own
  // adoption of a still-present earlier complaint — the same accepted,
  // fingerprint-only dedupe limitation crash-loop.ts's own tracker has).
  // The per-id ENTRY itself is pruned only by `forgetMissing`, same as every
  // other map here.
  const yieldTimes = new Map<string, number[]>();
  const yieldSpoken = new Set<string>();
  const yieldCappedLogged = new Set<string>();
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  const log = (line: string) => deps.log?.(line);
  const maxSleepMs = deps.maxSleepMinutes * 60_000;
  const yieldWindowMs = deps.yieldLoopWindowMinutes * 60_000;

  async function postYieldLoopComplaint(id: string, count: number): Promise<void> {
    const rows = await deps.comments(id).catch((e) => {
      log(`WARNING: [yieldloop] comments fetch failed for ${id}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    if (rows === null) return; // could not check -> try again on a later wake, never post blind
    const existing = findMarked(rows, YIELD_LOOP_MARKER, [resourceKey(id)]);
    if (existing) {
      log(`[yieldloop] adopted existing complaint for ${id} from comment ${existing.id} (daemon restart)`);
      yieldSpoken.add(id);
      return;
    }
    if (!rateCap.allow(id, deps.now())) {
      if (!yieldCappedLogged.has(id)) {
        yieldCappedLogged.add(id);
        log(`WARNING: [yieldloop] rate cap reached (${MAX_PER_HOUR}/hour) for ${id} — complaint logged only, not posted`);
      }
      return;
    }
    await deps.addComment(id, yieldLoopComment(id, count, deps.yieldLoopWindowMinutes));
    rateCap.record(id, deps.now());
    yieldCappedLogged.delete(id);
    yieldSpoken.add(id);
    log(`[yieldloop] ${id} woke ${count} times in ${deps.yieldLoopWindowMinutes}m — complaint posted`);
  }

  function recordEdgeWake(id: string): readonly number[] {
    const now = deps.now();
    // BUG FIX (found writing this module's own tests): the window-emptying
    // check must run over the PRIOR entries alone, before `now` is added —
    // `now` is always within `yieldWindowMs` of itself, so a filter applied
    // AFTER pushing `now` can never observe an empty array, and "the window
    // emptying out IS the signal a cluster ended" (this function's own
    // top-of-file doc comment) would never actually fire: `yieldSpoken`
    // would latch permanently after the first complaint, for the rest of
    // this id's lifetime in the active JQL set (issue.ts's `forgetMissing`
    // call only prunes an id once it leaves that set entirely — routinely
    // never, for a ticket that stays In Progress/In Review while asleep).
    const prior = (yieldTimes.get(id) ?? []).filter((t) => now - t < yieldWindowMs);
    if (prior.length === 0) yieldSpoken.delete(id); // no wake from the old cluster survives — a fresh one starts
    const times = [...prior, now];
    yieldTimes.set(id, times);
    return times;
  }

  return {
    standDown(id, seen) {
      const snapshot = new Map<string, ReadonlySet<string>>();
      for (const [key, ids] of seen) snapshot.set(key, new Set(ids));
      asleep.set(id, { seen: snapshot, sleptAt: deps.now() });
    },

    isAsleep(id) {
      return asleep.has(id);
    },

    hasBaseline(id, key) {
      return asleep.get(id)?.seen.has(key) ?? false;
    },

    unseenFor(id, key, observed) {
      const entry = asleep.get(id);
      const seen = entry?.seen.get(key);
      if (!seen) return [];
      return unseenIds(observed, [...seen]);
    },

    async wake(id, reason) {
      if (!asleep.has(id)) return;
      asleep.delete(id);
      crashLoopExempt.add(id);
      log(`[standdown] ${id} woke (${reason})`);
      if (reason !== "edge") return;
      const times = recordEdgeWake(id);
      if (yieldSpoken.has(id)) return;
      if (times.length < deps.yieldLoopCount) return;
      await postYieldLoopComplaint(id, times.length);
    },

    async tickMaxSleep(id) {
      const entry = asleep.get(id);
      if (!entry) return false;
      if (deps.now() - entry.sleptAt < maxSleepMs) return false;
      await this.wake(id, "bound");
      return true;
    },

    forgetMissing(stillPresent) {
      for (const id of [...asleep.keys()]) if (!stillPresent.has(id)) asleep.delete(id);
      for (const id of [...crashLoopExempt]) if (!stillPresent.has(id)) crashLoopExempt.delete(id);
      for (const id of [...yieldTimes.keys()]) if (!stillPresent.has(id)) { yieldTimes.delete(id); yieldSpoken.delete(id); }
    },

    consumeCrashLoopExemptions(admitted) {
      return admitted.filter((id) => {
        if (crashLoopExempt.has(id)) {
          crashLoopExempt.delete(id);
          return false;
        }
        return true;
      });
    },
  };
}
