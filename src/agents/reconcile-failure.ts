import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-147 — making an isolated herd.spawn/stop/respawn failure audible.
 * `reconcileNow` (src/daemon/loop.ts) used to let a single rejecting
 * `herd.spawn`/`herd.stop`/mid-respawn `herd.spawn` abort the ENTIRE poll:
 * `Promise.all(plan.spawn.map(...))` rejects on the first rejection, and the
 * `stop`/`respawn` `for` loops are unguarded `await`s, so one bad resource
 * skipped `stop`/`respawn` for every OTHER resource, `syncLabels`, and
 * `onPollSuccess` too. This module never touches that isolation itself (see
 * loop.ts) — it only watches the now-isolated failures and speaks.
 *
 * REUSE, NOT A SECOND PRIMITIVE: same `RateCap`/`findMarked`/`HOUR_MS`
 * (escalation-helper.ts) shape as crash-loop.ts/frozen-asleep.ts. `comments`/
 * `addComment` are caller-supplied through `speakOnOwnChannel`/
 * `createOwnChannelComments` (src/tools/speak.ts, src/daemon/index.ts) —
 * this module never has to know which channel shape (issue ticket vs.
 * project root doc) it's talking to.
 *
 * DISTINCT FROM crash-loop.ts, NOT A DUPLICATE OF IT (BUTCHR-147 §5): a
 * resource whose spawn rejects EVERY poll never becomes `running`, so it is
 * in `plan.spawn` on every poll and BUTCHR-141's crash-loop detector will
 * ALSO eventually post `[butchr:crashloop]` on the same resource once it
 * crosses 5 spawns/60 minutes (its own default). That complaint is a pure
 * COUNT — it does not and structurally cannot carry the rejection's actual
 * error message (crash-loop.ts never sees the rejection at all: it is called
 * BEFORE the spawn loop runs, with `plan.spawn`, not with any outcome). This
 * module's complaint is the only place in the codebase that ever says WHY a
 * spawn/stop/respawn failed — genuinely different information, not a
 * reworded duplicate — so both are left free to fire independently rather
 * than one suppressing or deferring to the other. Each is independently
 * rate-capped and latched per continuous episode, so the two together are
 * still bounded (at most 3+3 = 6 comments/hour/resource in the worst case,
 * never unbounded spam), and this module's marker/threshold are DELIBERATELY
 * faster than crash-loop's (2 failures within a short window vs. 5 spawns
 * within an hour) because carrying the actual error is exactly the
 * information an operator needs first, not after an hour-long wait for
 * crash-loop's own threshold.
 *
 * THE THRESHOLD: 2 failures of the SAME resource within a rolling 15-minute
 * window — a rolling count over a rolling window, same shape as crash-loop's
 * own threshold, not consecutive polls (mirrors that module's own reasoning:
 * the issue tier (15s) and project tier (5min) poll at very different
 * cadences). 15 minutes comfortably covers three consecutive project-tier
 * polls (0, 5, 10 minutes) so a persistent project-tier failure still
 * reaches the threshold well inside the window; on the issue tier a
 * persistent failure reaches it within about 30 seconds. A SINGLE failure
 * that recovers on the very next poll (the "transient one-poll blip" the
 * epic ranks as noise) never posts: with only one recorded failure, the
 * count never reaches 2 — it simply ages out of the window unless a second,
 * genuinely separate failure follows.
 *
 * SPEAK, NEVER SUPPRESS: this module never gates or delays a spawn/stop/
 * respawn — it is called AFTER `reconcileNow`'s isolated attempts for this
 * poll are already done (see loop.ts), purely to observe and report. Once a
 * resource crosses the threshold, one complaint is posted (or an existing
 * one adopted, on a daemon restart) and the id is latched so it is not
 * re-posted on every later poll while it keeps failing — same "already
 * spoken" shape as crash-loop.ts/frozen-asleep.ts. The latch is cleared only
 * when the id leaves `desired` (`forgetMissing`), so a later, genuinely NEW
 * failure episode for the same id starts a fresh floor and can alarm again.
 *
 * RESTART BEHAVIOUR: all tracking is in-memory, same disclosed limitation as
 * every other detector in this epic — losing it on a restart can only ever
 * DELAY this detector's own alarm (never fabricate one), and dedupe-by-
 * adoption (`findMarked` against the resource's own prior comments) still
 * protects against re-posting an ALREADY-POSTED complaint across a restart.
 */

/** Marker every complaint this module writes starts with — distinct from every other detector's marker in this codebase. */
export const MARKER = "[butchr:reconcile]";

/** Mirrors every other detector's per-target escalation budget: at most this many complaints per resource per rolling hour. */
const MAX_PER_HOUR = 3;

/** Failures of the same id within the rolling window before a complaint fires — see this module's own top comment for why 2, not 1 (a one-poll blip must not speak) and not crash-loop's 5 (this complaint carries the actual error, so it should surface faster). */
const THRESHOLD_COUNT = 2;

/** The rolling window this module measures `THRESHOLD_COUNT` over — see this module's own top comment for why 15 minutes covers both poll tiers. */
const WINDOW_MS = 15 * 60_000;
const WINDOW_MINUTES = WINDOW_MS / 60_000;

/** Which herd operation failed. Mirrors `reconcileNow`'s own three stages (src/daemon/loop.ts). */
export type ReconcileStage = "spawn" | "stop" | "respawn";

/** One isolated herd operation failure for one resource, this poll. */
export interface ReconcileFailure {
  id: string;
  stage: ReconcileStage;
  error: unknown;
}

/**
 * The dedupe/adoption key embedded in `reconcileFailureComment`'s last line —
 * bracket-delimited on both sides so `findMarked`'s plain substring match
 * (escalation-helper.ts) can never false-match a longer id that happens to
 * share this id as a prefix (`BUTCHR-1` inside `BUTCHR-12`) — same reasoning
 * as crash-loop.ts's own `resourceKey`.
 */
function resourceKey(id: string): string {
  return `resource: [${id}]`;
}

interface Entry {
  /** Timestamps (ms) of every isolated failure observed for this id, pruned to the rolling window on each observation. Never persisted. */
  failTimes: number[];
  /** The stage and message of the MOST RECENT failure — what the complaint text reports. */
  lastStage: ReconcileStage;
  lastMessage: string;
  /** Set once a complaint has been posted (or adopted) for this id's CURRENT continuous episode — from then on this id is skipped with no further I/O until it drops out of `desired` (see `forgetMissing`). */
  spokenAt?: number;
}

/**
 * Per-id in-memory rolling-window failure count + "already spoken" latch —
 * same shape as crash-loop.ts's `CrashLoopTracker`.
 */
export class ReconcileFailureTracker {
  private readonly entries = new Map<string, Entry>();

  /** Drop tracking for every id not in `stillInPlay` this poll. */
  forgetMissing(stillInPlay: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!stillInPlay.has(key)) this.entries.delete(key);
  }

  /** Record a failure observed for `id` at `at`; returns the timestamps still inside the rolling `windowMs` window (oldest-first). */
  recordFailure(id: string, stage: ReconcileStage, message: string, at: number, windowMs: number): readonly number[] {
    const e = this.entries.get(id) ?? { failTimes: [], lastStage: stage, lastMessage: message };
    if (!this.entries.has(id)) this.entries.set(id, e);
    e.failTimes = [...e.failTimes, at].filter((t) => at - t < windowMs);
    e.lastStage = stage;
    e.lastMessage = message;
    return e.failTimes;
  }

  /** Whether `id` has already had a complaint posted or adopted for its current episode. */
  isSpoken(id: string): boolean {
    return this.entries.get(id)?.spokenAt !== undefined;
  }

  /** Latch `id` as spoken-for as of `at` — only ever called once a complaint has actually posted or been adopted. */
  markSpoken(id: string, at: number): void {
    this.entries.get(id)!.spokenAt = at;
  }
}

/**
 * Deliberately OBSERVATIONAL, not accusatory (same register as every other
 * detector in this epic): names the resource, which stage failed, how many
 * times, over what window, and carries the actual rejection message — the
 * one thing an operator cannot get anywhere else (crash-loop.ts's complaint
 * never has it). NOT answerable and must not look answerable: no
 * fingerprint, no `ANSWER` line — proven immune to the real `parseDirective`
 * by test, not eyeballed.
 */
function reconcileFailureComment(id: string, stage: ReconcileStage, count: number, message: string): string {
  return [
    `${MARKER} ${id}'s reconcile has failed ${count} time(s) in the last ${WINDOW_MINUTES} minutes — most recently during ${stage}: ${message}`,
    "",
    `This is a report, not a suppression: ${id} is isolated from the rest of the fleet (other resources' polls are unaffected) and will keep being retried on every poll exactly as before. If it cannot recover on its own, a human should look at why ${stage} keeps failing rather than waiting for it to recover unattended.`,
    "",
    resourceKey(id),
  ].join("\n");
}

export interface ReconcileFailureDetectorDeps {
  now: () => number;
  /** Post through the resource's own channel — never a second Atlassian writer (see src/daemon/index.ts's wiring through speakOnOwnChannel). */
  addComment: (id: string, text: string) => Promise<void>;
  /** Recent comments/complaints on `id`'s own channel, newest-first is fine — see this module's own top comment for why a fetch FAILURE must be distinguishable from "fetched fine, nothing found" (never collapsed into the same branch — Rule 2a). */
  comments: (id: string) => Promise<readonly CommentRow[]>;
  log?: (line: string) => void;
}

export interface ReconcileFailureDetector {
  /**
   * One poll's worth of detection, called AFTER `reconcileNow`'s isolated
   * spawn/stop/respawn attempts for this poll (src/daemon/loop.ts) —
   * `failures` is exactly the set that failed this poll; `desired` and
   * `running` are `desired.keys()`/`herd.runningIssues()` from the SAME
   * poll, used only for pruning (see `forgetMissing`). Never gates or delays
   * anything and is never consulted for control flow — see the audible-only
   * ruling in this module's own top comment. Never throws.
   *
   * REVIEW FIX (BUTCHR-147, PR #204 round 1): pruning used to key on
   * `desired` alone, copied from crash-loop.ts's own tracker. That key is
   * safe THERE because crash-loop.ts only ever tracks `plan.spawn` ids,
   * which are in `desired` by construction (`spawn = desired − running`).
   * This module widened the tracked set to all three stages, and a
   * `plan.stop` id is in `desired` NEVER (`stop = running − desired −
   * atRest`, src/reconcile/plan.ts) — so keying only on `desired` deleted
   * every stop-failure entry on the very next poll, before a second failure
   * could ever be recorded: the count was pinned at 1 forever and a
   * persistently-failing `herd.stop` could never reach `THRESHOLD_COUNT`
   * and never spoke. Measured on PR #204's review: 10 consecutive polls of a
   * persistently-failing stop produced zero complaints.
   *
   * `desired ∪ running` is safe for all three stages: `plan.spawn` ⊆
   * `desired`, `plan.respawn` ⊆ `desired ∩ running`, and `plan.stop` ⊆
   * `running` (all per `planReconcile`'s own definitions) — so an id that
   * keeps failing the SAME stage every poll necessarily keeps satisfying
   * this union every poll (a resource whose `herd.stop` keeps failing is,
   * by definition, still running), and an entry is only ever dropped once
   * the id genuinely leaves both sets — i.e. once it is truly no longer in
   * play, which is exactly when forgetting it (and thus resetting its
   * episode) is correct. This still bounds the map: an id absent from BOTH
   * `desired` and `running` for a whole poll cannot still be failing
   * anything this module tracks.
   */
  check: (failures: readonly ReconcileFailure[], desired: readonly string[], running: readonly string[]) => Promise<void>;
}

/** Builds the detector wired into `reconcileNow`'s `ReconcileOptions.checkReconcileFailure` (src/daemon/loop.ts), called once per poll after the isolated spawn/stop/respawn attempts. */
export function createReconcileFailureDetector(deps: ReconcileFailureDetectorDeps): ReconcileFailureDetector {
  const tracker = new ReconcileFailureTracker();
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  // One "rate cap reached" WARNING per id until it frees up — mirrors every
  // other detector's `cappedLogged`: without this a permanently-capped id
  // would log once per poll forever.
  const cappedLogged = new Set<string>();
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) complaint for `id`. Returns the time
   * it was posted/adopted, or null when nothing changed this poll (a failed
   * fetch, or the rate cap) — null means "not written this poll, try again
   * next time", never "give up" (this module never gates a spawn/stop/
   * respawn, so there is nothing to reap or retry here besides the comment
   * itself).
   */
  async function postComplaint(id: string, stage: ReconcileStage, count: number, message: string): Promise<number | null> {
    const rows = await deps.comments(id).catch((e) => {
      log(`WARNING: [reconcile] comments fetch failed for ${id}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    // COULD NOT CHECK vs. CHECKED, FOUND NOTHING — never the same branch
    // (Rule 2a): `rows === null` here can only mean the former.
    if (rows === null) return null;
    const existing = findMarked(rows, MARKER, [resourceKey(id)]);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      log(`[reconcile] adopted existing complaint for ${id} from comment ${existing.id} (daemon restart)`);
      return adoptedAt;
    }
    if (!rateCap.allow(id, deps.now())) {
      if (!cappedLogged.has(id)) {
        cappedLogged.add(id);
        log(`WARNING: [reconcile] rate cap reached (${MAX_PER_HOUR}/hour) for ${id} — complaint logged only, not posted (further cap hits for ${id} are logged only once until it frees up)`);
      }
      return null;
    }
    await deps.addComment(id, reconcileFailureComment(id, stage, count, message));
    rateCap.record(id, deps.now());
    cappedLogged.delete(id);
    const postedAt = deps.now();
    log(`[reconcile] ${id} ${stage} failed ${count} times in ${WINDOW_MINUTES}m — complaint posted (${message})`);
    return postedAt;
  }

  async function check(failures: readonly ReconcileFailure[], desired: readonly string[], running: readonly string[]): Promise<void> {
    try {
      tracker.forgetMissing(new Set([...desired, ...running]));
      for (const f of failures) {
        const message = (f.error as Error)?.message ?? String(f.error);
        const times = tracker.recordFailure(f.id, f.stage, message, deps.now(), WINDOW_MS);
        if (tracker.isSpoken(f.id)) continue;
        if (times.length < THRESHOLD_COUNT) {
          log(`[reconcile] ${f.id} ${f.stage} failed (${times.length}/${THRESHOLD_COUNT} within ${WINDOW_MINUTES}m) — not yet posting: ${message}`);
          continue;
        }
        const at = await postComplaint(f.id, f.stage, times.length, message);
        if (at !== null) tracker.markSpoken(f.id, at);
      }
    } catch (e) {
      log(`WARNING: [reconcile] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
