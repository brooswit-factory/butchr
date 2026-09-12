import { StalledTracker, type ObservedLabel } from "./stalled.js";
import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";
import { mapAgentStatus } from "../labels/plan.js";

/**
 * BUTCHR-305/BUTCHR-238 — bounds the ONE shape in the reconciler's plan that
 * nothing else touches: a resource id that is `desired` (its
 * `Activation.verdictFor` said `"active"`) AND `running` (its agent is up)
 * AND not argv-stale. `planReconcile` (src/reconcile/plan.ts) never puts
 * such an id in `spawn`, `stop`, or `respawn` — correct and desirable while
 * the agent is genuinely working, but structurally identical to a resource
 * PINNED active by an agent that has simply stopped acting (parked, hung, or
 * finished a turn without ever calling `check_in`). See this ticket's own
 * doc/PART 1 for the full derivation of why every OTHER detector on
 * `ReconcileOptions` structurally cannot see this shape (`checkFrozenAsleep`/
 * `checkDeclaredDone` only ever see `atRest`, which an `"active"` verdict is
 * never a member of; `checkCrashLoop`/`admission` only ever see spawn
 * candidates; `checkReconcileFailure` only ever sees a rejected operation;
 * `checkReap` only ever sees ids with NO agent).
 *
 * WHY THIS IS PROJECT-TIER ONLY: the issue tier already has a mechanism that
 * sees exactly this shape — `src/agents/stalled.ts` (the idle-streak floor)
 * paired with `src/agents/stall-remediation.ts` (the debounced wake) — but
 * it is reachable only via `syncLabels` (src/labels/sync.ts), wired into the
 * issue-tier `runResourceLoop` call in src/daemon/index.ts alone; the
 * project-tier call never receives `syncLabels`. That wiring is not an
 * oversight to fix by threading `syncLabels` into the project loop too: the
 * remediator's own gating requires the `agent:stalled` JIRA LABEL as already
 * applied and read back — a Jira label is a Jira ISSUE concept, and a
 * PROJECT key is not addressable as a Jira issue at all (`speak.ts` records
 * the measurement: `GET /rest/api/3/issue/<PROJECT>` -> 404 where an issue
 * key -> 200). This module is the project tier's OWN mechanism for the same
 * shape, built to the same standard but with no label as its carrier.
 *
 * REUSES `StalledTracker` (stalled.ts) DIRECTLY for the idle-streak floor —
 * not `createStalledCheck`, whose comment-based disqualification logic is
 * issue-shaped (it disqualifies a candidate on a non-daemon-chatter Jira
 * comment landing during the streak, a check this module has no ticket to
 * read comments FROM in that sense — a project's OWN channel comments are
 * read here only for THIS module's own dedupe/adoption, never to disqualify
 * a stalled reading). Reuses `findMarked`/`RateCap` from
 * escalation-helper.ts for the cap and dedupe, same house mechanism every
 * sibling detector (`frozen-asleep.ts`, `stall-remediation.ts`, `parked.ts`)
 * already uses.
 *
 * NEVER REAP, NEVER GATE (constraint 1, the reviewer's hardest line): this
 * module's `check` returns `void`, consulted by nobody — it must never touch
 * `plan`, `atRest`, `desired`, `running`, or `admitted`. Shaped after
 * `checkCrashLoop`/`checkReconcileFailure` on `ReconcileOptions`
 * (src/daemon/loop.ts), never after `checkFrozenAsleep`: a project pinned
 * ACTIVE may be legitimately doing long, real work, and killing a working
 * agent costs its whole ticket while a false wake costs one comment.
 * MEASURED, not assumed (this ticket's own boss's report, relayed on
 * BUTCHR-305): the sibling mechanism this module ports fired unaided in
 * production on an agent that was genuinely working, not stuck — the agent
 * read the comment and carried on 32 seconds later. The COST OF BEING WRONG
 * is asymmetric in exactly the direction that makes speaking safe and
 * reaping not: one comment in one direction, a killed working agent (and its
 * whole ticket's lost work) in the other.
 *
 * NEVER FIRE ON ELAPSED-ACTIVE TIME ALONE (constraint 2): "this project has
 * read ACTIVE for N minutes" cannot distinguish a busy project from a pinned
 * one. The idle/done streak of the AGENT — `StalledTracker`'s own floor,
 * re-armed the instant `working`/`blocked` is observed — is the only trigger
 * this module uses. Stated plainly, because it is NOT the same claim as
 * "separates stuck from correctly-waiting": it does not, and cannot — there
 * is no signal observable from outside that tells apart an agent that is
 * idle because it is stuck from one that is idle because it is correctly
 * waiting on something it cannot influence (a boss's review, a queued slot).
 * This module will sometimes speak to a healthy, correctly-waiting agent.
 * That is a property of this design, not a defect in it: constraint 1 exists
 * precisely because this same epistemic limit applies one layer up too
 * (pinned vs. busy is equally unobservable), and a mechanism that cannot make
 * either distinction must never take an irreversible action on either one.
 *
 * FAIL CLOSED ON A FAILED COMMENTS FETCH (constraint 5, "the dedupe trap"):
 * "checked and found nothing to adopt" and "could not check" must never take
 * the same branch — this module's `postComplaint` copies frozen-asleep.ts's
 * own `postComplaint` for exactly this reason: a failed fetch posts nothing
 * and retries next poll, never "nothing to adopt, post a fresh one" (which
 * would spam the doc on every transient fetch failure).
 *
 * IN-MEMORY TRACKING IS FINE (constraint 8): every floor and latch here is
 * lost on a daemon restart. That can only ever DELAY a complaint (a fresh
 * floor starts counting from the restart), never fabricate one early, and
 * adoption-dedupe (`findMarked` against the project's own already-posted
 * comments) is what stops a restart from re-posting a complaint made in a
 * prior process's lifetime — same reasoning `stalled.ts`, `frozen-asleep.ts`
 * and `stall-remediation.ts` already rely on for their own floors.
 */

/** Marker every complaint this module writes starts with — same `[butchr:` daemon-chatter convention every sibling detector uses. */
export const MARKER = "[butchr:pinned]";

/** Mirrors frozen-asleep.ts/stall-remediation.ts's per-target escalation budget. */
const MAX_PER_HOUR = 3;

/**
 * The delimited identity `findMarked` matches against. NOT a bare
 * `fingerprint: ${id}` with nothing after it — see stall-remediation.ts's
 * `wakeComment` doc comment for why: `findMarked` matches with a bare
 * `body.includes(...)`, and Jira/project keys are not prefix-free
 * (`"fingerprint: BUTCHR"` is a substring of `"fingerprint: BUTCHRX"`). The
 * trailing `\n` (present because a further line always follows it in
 * `pinnedActiveComment` below) is what actually prevents that collision.
 */
const fingerprintNeedle = (id: string): string => `fingerprint: ${id}\n`;

/**
 * Deliberately OBSERVATIONAL, not accusatory (constraint 7) — same reasoning
 * as `frozenComment` (frozen-asleep.ts): the daemon can see state, not
 * intent, so it reports what it measured — the resource, how long it has
 * been idle, and what is (and is not) being done about it — and lets the
 * reader draw the conclusion. Does NOT say the agent is broken.
 */
function pinnedActiveComment(id: string, elapsedMinutes: number, boundMinutes: number): string {
  return [
    `${MARKER} ${id} has read ACTIVE, with its agent running and idle/done, continuously, for ${elapsedMinutes} minute(s) — past the ${boundMinutes}-minute window.`,
    "",
    "Nothing is being stopped or restarted because of this: an ACTIVE project may genuinely be doing long-running work this comment cannot see, and this mechanism only observes and speaks. If this agent is stuck, act on it now. If it is correctly waiting on something else (a review, a queued slot), no action is needed — this is a wake, not an accusation.",
    "",
    `fingerprint: ${id}`,
    "",
    "This comment is watermarked against this project's own wake trigger and will not re-activate it.",
  ].join("\n");
}

export interface PinnedActiveDetectorDeps {
  now: () => number;
  /** Minutes an idle/done streak must hold, uninterrupted, before a complaint is posted — reuses config.stalledMinutes (BUTCHR_STALLED_MINUTES): same phenomenon (an idle/done agent, unattended, past a window), same threshold semantics as the issue tier's own `stalled` check. */
  minutes: number;
  /**
   * issue/project id -> raw herdr agent_status for every currently running
   * butchr agent. THE SAME closure src/daemon/index.ts already builds for
   * `createLabelSync`'s own `agentStatuses` dep (built by teeing
   * `herdr.agent.list()` through workspace-path identity) — wired here from that
   * existing seam, never a second reader.
   */
  agentStatuses: () => Promise<ReadonlyMap<string, string>>;
  /** Post through the resource's own channel — `speakOnOwnChannel` (src/tools/speak.ts), never `ops.addComment`/`ops.commentOnPage` directly (constraint 3 — see this module's own top comment). */
  addComment: (id: string, text: string) => Promise<void>;
  /** Recent comments on the resource's own channel — `createOwnChannelComments` (src/tools/speak.ts), the project-aware reader (constraint 4). Newest-first is fine. */
  comments: (id: string) => Promise<readonly CommentRow[]>;
  /**
   * BUTCHR-221's quota gate, the SAME instance wired into
   * `stall-remediation.ts` in src/daemon/index.ts (constraint 6): a
   * quota-blocked agent is idle and cannot act, and posting into it burns the
   * very session quota whose return ends the outage — the session-limit path
   * owns that case (see this module's own top comment, PART 4 of the
   * ticket). Optional; omitted, no quota check runs (matches every other
   * optional dep in this codebase's detector family).
   */
  quotaBlocked?: (id: string) => boolean;
  log?: (line: string) => void;
}

export interface PinnedActiveDetector {
  /**
   * One poll's worth of detection over the ids that are CURRENTLY both
   * `desired` (verdict `"active"`) and `running` (agent up) — the caller
   * (`reconcileNow`, src/daemon/loop.ts) computes this intersection, since it
   * already has both sets. Returns nothing and is never consulted — see this
   * module's own top comment, constraint 1. Never throws.
   */
  check: (activeRunning: readonly string[]) => Promise<void>;
}

/**
 * Builds the pinned-active detector wired into `reconcileNow`'s
 * `ReconcileOptions.checkPinnedActive` (src/daemon/loop.ts) via the
 * project-tier `runResourceLoop` call only (src/daemon/index.ts) — see this
 * module's own top comment for why issue-tier wiring would double-post
 * (`syncLabels`/`stallRemediation` already cover that tier).
 */
export function createPinnedActiveDetector(deps: PinnedActiveDetectorDeps): PinnedActiveDetector {
  const tracker = new StalledTracker(deps.now, deps.minutes);
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  // spokenAt per id — set once a complaint has been posted or adopted for
  // the CURRENT continuous idle episode; cleared the moment that id's streak
  // breaks (agent observed working/blocked again) or the id leaves the
  // active+running candidate set, so a LATER episode starts fresh rather
  // than inheriting a stale latch.
  const spoken = new Map<string, number>();
  // The instant (this process's OWN clock) each id's most recently CLOSED
  // episode ended — set only when an episode that HAD a spoken-for complaint
  // is observed to close (streak breaks, or the id leaves the candidate set
  // entirely) while this process is live. See `postComplaint`'s own doc
  // comment for why this — not a comparison against `StalledTracker`'s own
  // streak-start floor, which is reset by a restart and would otherwise
  // wrongly invalidate a still-open episode's own complaint — is what lets a
  // genuinely fresh episode complain again without breaking adoption-dedupe
  // for the ordinary "same episode, process merely restarted" case.
  const closedBefore = new Map<string, number>();
  // Which ids this module is currently tracking at all — used only to know
  // which StalledTracker/spoken entries to drop when an id disappears from
  // the candidate set (mirrors FrozenAsleepTracker.forgetMissing's shape,
  // applied externally here since StalledTracker itself has no batch-forget
  // of its own and this module reuses it unmodified).
  let previousCandidates = new Set<string>();
  // One "rate cap reached" WARNING per id until it frees up — mirrors
  // frozen-asleep.ts/stall-remediation.ts's own copy of the same pattern.
  const cappedLogged = new Set<string>();
  const loggedFailure = new Map<string, string>();
  const quotaLogged = new Set<string>();
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) complaint for `id`. Returns the time
   * it was posted/adopted, or null when nothing changed this poll (a failed
   * fetch, or the rate cap) — null means "stays silent, try again next
   * poll", exactly frozen-asleep.ts's own `postComplaint` contract.
   *
   * WHY THIS TAKES `closedBeforeTs`, UNLIKE frozen-asleep.ts/stall-remediation.ts's
   * OWN `postComplaint`s: those modules dedupe on a bare per-id fingerprint,
   * with NO episode component, DELIBERATELY (frozen-asleep.ts's own doc
   * comment; stall-remediation.ts posts at most once per issue for the
   * ticket's LIFETIME, by explicit design). This module is required to do
   * the opposite (see this module's own top comment and the ticket's
   * reachability test, item 6): once the agent is observed working again and
   * later goes idle again, a FRESH episode must be able to complain again,
   * not be latched shut forever by a complaint some earlier, closed episode
   * already posted. A bare `findMarked(rows, MARKER, [fingerprint])` cannot
   * tell those apart — it would find the OLD complaint and wrongly suppress
   * the new episode's first one, even with NO restart involved at all.
   *
   * THE FIX, AND WHY IT IS `closedBefore` RATHER THAN `StalledTracker`'s OWN
   * `streakStart`: comparing against `streakStart` was the first design
   * tried here, and it is WRONG — a daemon restart mid-episode (the agent
   * has been continuously idle the whole time, spanning the restart) loses
   * the TRUE streak start (`StalledTracker`'s fresh floor starts from the
   * restart's own first observation, LATER than the prior complaint's
   * `created`), so that comparison would read a still-open episode's own
   * complaint as "previous episode" and re-post — every time the daemon
   * restarts during an ongoing stall, which is a common, not a rare, event.
   * `closedBefore` instead only ever advances when THIS PROCESS ITSELF
   * observes an episode that HAD a spoken-for complaint actually close (see
   * `check`'s own bookkeeping below) — never merely from a tracker floor
   * resetting. A process that has never observed a closure for `id` (a
   * fresh restart, mid-episode) treats every fingerprint match as adoptable,
   * exactly frozen-asleep.ts's/stall-remediation.ts's own safe default; a
   * live process that DID observe its own episode close can correctly tell
   * a stale match from a live one.
   *
   * THE NARROWER GAP THIS STILL LEAVES, STATED RATHER THAN HIDDEN: a restart
   * landing in the specific window AFTER a real episode closed but BEFORE
   * (or during) a fresh one forming for the SAME id loses the in-memory
   * `closedBefore` entry too, so the fresh episode's own first attempt could
   * find the old complaint and wrongly adopt it — one missed wake, not a
   * fabricated one. Rarer than the `streakStart` design's failure (which
   * fires on every ordinary restart-during-a-stall), and the SAME
   * conditionally-unbounded state this ticket exists to bound is still
   * caught on this id's NEXT stall after that, since nothing here ever makes
   * a genuinely re-opened episode permanently unreachable — it is a delay,
   * not a loss.
   */
  async function postComplaint(id: string, elapsedMinutes: number, closedBeforeTs: number | undefined): Promise<number | null> {
    const rows = await deps.comments(id).catch((e) => {
      log(`WARNING: [pinned] comments fetch failed for ${id}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    // COULD NOT CHECK: a distinct branch from "checked, found nothing" below
    // — collapsing the two would either re-post on every failed fetch or,
    // worse, be indistinguishable from a confirmed-clean check (constraint 5,
    // the dedupe trap).
    if (rows === null) return null;
    const existing = findMarked(rows, MARKER, [fingerprintNeedle(id)]);
    if (existing) {
      const createdAt = Date.parse(existing.created);
      const staleFromAClosedEpisode = closedBeforeTs !== undefined && !Number.isNaN(createdAt) && createdAt <= closedBeforeTs;
      if (!staleFromAClosedEpisode) {
        const adoptedAt = Number.isNaN(createdAt) ? deps.now() : createdAt;
        log(`[pinned] adopted existing complaint for ${id} from comment ${existing.id} (daemon restart)`);
        return adoptedAt;
      }
      // Belongs to a previous episode THIS PROCESS ITSELF watched close —
      // fall through and treat this poll as if nothing were found, so the
      // new episode gets its own complaint.
    }
    if (!rateCap.allow(id, deps.now())) {
      if (!cappedLogged.has(id)) {
        cappedLogged.add(id);
        log(`WARNING: [pinned] rate cap reached (${MAX_PER_HOUR}/hour) for ${id} — complaint logged only, not posted (further cap hits for ${id} are logged only once until it frees up)`);
      }
      return null;
    }
    try {
      await deps.addComment(id, pinnedActiveComment(id, elapsedMinutes, deps.minutes));
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (loggedFailure.get(id) !== message) {
        loggedFailure.set(id, message);
        log(`WARNING: [pinned] complaint write failed for ${id}: ${message}`);
      }
      return null;
    }
    loggedFailure.delete(id);
    rateCap.record(id, deps.now());
    cappedLogged.delete(id);
    const postedAt = deps.now();
    log(`[pinned] ${id} past the ${deps.minutes}-minute pinned-active window (${elapsedMinutes}m) — complaint posted`);
    return postedAt;
  }

  async function check(activeRunning: readonly string[]): Promise<void> {
    try {
      const current = new Set(activeRunning);
      for (const id of previousCandidates) {
        if (!current.has(id)) {
          // Leaving the candidate set entirely closes any open episode just
          // as surely as observing "working" does — see the loop below for
          // why a spoken-for episode's closure is recorded in `closedBefore`.
          if (spoken.has(id)) closedBefore.set(id, deps.now());
          tracker.forget(id);
          spoken.delete(id);
        }
      }
      previousCandidates = current;
      if (!activeRunning.length) return;

      const statuses = await deps.agentStatuses();
      for (const id of activeRunning) {
        const label: ObservedLabel = mapAgentStatus(statuses.get(id) ?? null);
        const qualifies = tracker.observe(id, label);
        if (!qualifies) {
          // Streak broken (or not yet started) this poll — never a
          // candidate right now. If this episode had already been spoken
          // for, its closure must be remembered (`closedBefore`) so a LATER
          // fresh episode's own dedupe check does not wrongly adopt this
          // now-stale complaint — see `postComplaint`'s own doc comment.
          if (spoken.has(id)) closedBefore.set(id, deps.now());
          spoken.delete(id);
          continue;
        }
        if (spoken.has(id)) continue; // steady state: already remediated this episode, silent.
        if (deps.quotaBlocked?.(id)) {
          if (!quotaLogged.has(id)) {
            quotaLogged.add(id);
            log(`[pinned] ${id} quota-blocked — suppressing complaint (target cannot read it while blocked, and the session-limit path owns this case)`);
          }
          continue; // deliberately does NOT latch spoken: a later poll, quota recovered and still idle, must still be free to act.
        }
        if (quotaLogged.delete(id)) log(`[pinned] ${id} no longer quota-blocked — complaint eligible again`);

        const elapsedMinutes = tracker.elapsedMinutes(id) ?? 0;
        const at = await postComplaint(id, elapsedMinutes, closedBefore.get(id));
        if (at !== null) spoken.set(id, at);
      }
    } catch (e) {
      log(`WARNING: [pinned] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
