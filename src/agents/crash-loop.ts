import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-141 — making a crash-looping agent audible. `planReconcile`
 * (src/reconcile/plan.ts) computes `spawn = desired − running`. A resource
 * whose agent dies (a startup crash, a session-limit refusal that never
 * clears, a swallowed kickoff, a workspace that fails to build) drops out of
 * `running` on the very next poll while its ticket is still active and
 * therefore still `desired` — so it is spawned again, forever, with nothing
 * to stop it and NOTHING TO SAY SO. This module never touches the spawn
 * path itself (see the ruling below) — it only watches it and speaks.
 *
 * PINNED BY THE TICKET, NOT THIS MODULE'S OWN CHOICE: audible-only, never
 * suppressed. `reconcileNow` (src/daemon/loop.ts) calls this module's
 * `check` with `plan.spawn` and `desired.keys()` BEFORE the spawn loop runs
 * and NEVER consults its return value — `check` returns `void`. Suppressing
 * a spawn here would introduce a liveness failure mode of its own: a
 * resource that would genuinely have recovered never gets another chance
 * and is now silently unattended, which is this epic's own defect inverted.
 * `src/reconcile/plan.ts` is untouched by this ticket; `git diff` on it from
 * this branch's base is empty.
 *
 * THE CANDIDATE SET AND THE PRUNING TRAP: candidates are ids repeatedly
 * appearing in `plan.spawn`, counted here. `forgetMissing` is keyed on
 * `desired` (the ticket left the active statuses), NEVER on "absent from
 * `plan.spawn` this poll" — a slower crash loop (spawn, live for one poll,
 * die, respawn) is absent from `plan.spawn` on every poll it happens to
 * still be running, and pruning on that shape would reset the counter every
 * such poll, so the alarm would silently never fire. `check`'s own two
 * parameters (`spawning`, `desired`) exist because of this: `spawning`
 * drives what gets a fresh recorded timestamp, `desired` drives what is
 * still tracked at all.
 *
 * THE CONFIDENT-ZERO HAZARD, INVERTED FORM (epic criterion 9): `plan.spawn`
 * is computed locally after `herd.runningIssues()` returns — if that call
 * REJECTS, `reconcileNow` throws before `planReconcile` ever runs and this
 * module's `check` is never called, so it cannot record a false zero. The
 * dangerous direction is the opposite one: `herd.runningIssues()` resolving
 * to an EMPTY ARRAY when herdr is up but reporting nothing is
 * indistinguishable, from here, from "genuinely nothing is running" — every
 * desired resource then lands in `plan.spawn` AT ONCE, which would make this
 * detector post on every active ticket simultaneously the moment each
 * crossed its threshold — a fleet-wide false crash-loop alarm, exactly the
 * "spam destroys a channel's credibility" outcome this epic ranks worse than
 * silence. `check` treats a poll where `plan.spawn` is EXACTLY EQUAL to the
 * ENTIRE `desired` set (see the guard's own precise condition below — not
 * merely "most of it") as evidence about herdr, not about any individual
 * resource: it logs and counts NONE of that poll's spawns toward any id's
 * window, rather than trusting them.
 *
 * DISCLOSED LIMITATION (review round 1, PR #195): for a TRANSIENT herdr blip
 * this can only ever DELAY detection — the same "delay, never fabricate"
 * guarantee this codebase's other floors already rely on for a daemon
 * restart. It is NOT merely a delay for a PERSISTENT condition: if the whole
 * (more-than-one-member) `desired` set stays crash-looping simultaneously —
 * the COMMON-CAUSE shape (an expired credential, a bad global config, a
 * herdr misconfiguration) is arguably the likeliest way more than one
 * resource ever crash-loops at once — this guard's own condition holds on
 * EVERY poll for as long as that persists, so it suppresses the alarm
 * INDEFINITELY, not merely delays it (measured: a 2-resource fleet, both
 * crash-looping, over 240 issue-tier polls — a full hour — posts zero
 * complaints). This is a DELIBERATE trade-off, not an oversight: fanning a
 * complaint out to every ticket in a crash-looping fleet at once is judged
 * worse than staying silent on the sustained common-cause case, for the same
 * "spam destroys credibility" reason the guard exists at all. If this
 * trade-off is ever revisited, the natural fix is a SEPARATE, non-fanned-out
 * signal for the sustained-fleet-wide case specifically — not weakening or
 * removing this guard, which stays correct for the far more common transient
 * blip.
 *
 * THE THRESHOLD: a rolling COUNT over a rolling TIME WINDOW, not consecutive
 * polls — the issue tier (15s) and the project tier (5min,
 * `PROJECT_POLL_INTERVAL_MS`) poll at very different cadences, and an
 * alternating loop (see the pruning trap above) breaks a consecutive streak
 * even for a genuine crash loop. Configurable via `BUTCHR_CRASHLOOP_COUNT`/
 * `BUTCHR_CRASHLOOP_WINDOW_MINUTES` (src/config/config.ts), default 5 spawns
 * / 60 minutes — see that config field's own doc comment for the full
 * reasoning (issue-tier margin, project-tier margin, and the project-tier
 * wake-cycle false-positive check).
 *
 * SPEAK, NEVER SUPPRESS, NEVER LATCH SILENT FOREVER: once a resource crosses
 * the threshold, one complaint is posted (or an existing one adopted, on a
 * daemon restart) and the id is latched so it is not re-posted on every
 * later poll while it keeps crash-looping — same "already spoken" shape as
 * `frozen-asleep.ts`'s `FrozenAsleepTracker`. The latch is cleared only when
 * the id leaves `desired` (`forgetMissing`), so a later, genuinely NEW
 * episode for the same id (the ticket went inactive and came back) starts a
 * fresh floor and can alarm again — it is not a one-time-ever latch.
 *
 * REUSE, NOT A SECOND PRIMITIVE: `RateCap`/`findMarked`/`HOUR_MS`
 * (escalation-helper.ts) — the same rate-cap/dedupe shape every detector in
 * this epic uses. `comments`/`addComment` are caller-supplied exactly like
 * `frozen-asleep.ts`'s own deps — the caller (src/daemon/index.ts) wires
 * `addComment` through `speakOnOwnChannel` and `comments` through the
 * extracted `createOwnChannelComments` (src/tools/speak.ts), so this module
 * never has to know which channel shape (issue ticket vs. project root doc)
 * it is talking to, and works for a resource with NO ticket at all, per
 * acceptance criterion 3.
 *
 * ONE INSTANCE PER LOOP, DELIBERATELY NOT MODULE-LEVEL: `src/daemon/index.ts`
 * calls `runResourceLoop` twice (issue tier, project tier) — a crash loop has
 * no `atRest`-style restriction to one tier (unlike frozen-asleep, which only
 * the project tier can ever produce), so this is wired into BOTH, each with
 * its OWN `createCrashLoopDetector` instance — the same reasoning
 * `RespawnGuard` already follows (one instance per `runResourceLoop` call).
 *
 * RESTART BEHAVIOUR (epic criterion 7 — deliberately NOT inherited from
 * frozen-asleep/BUTCHR-95's answer, because the failure mode is worse here):
 * all tracking is in-memory. Losing it on a restart can only ever DELAY a
 * genuine crash loop's eventual alarm for every OTHER detector in this epic
 * — but for THIS detector specifically, a daemon that restarts more often
 * than the window takes to fill could in principle mean the count NEVER
 * reaches the threshold at all, since each restart resets every id's
 * spawn-timestamp array to empty. This is stated, not solved, here — see
 * this ticket's own report/doc for the measured daemon-uptime bound this
 * implies, since that bound is a fact about THIS daemon's own observed
 * restart cadence, not something this module can assert about itself.
 * Dedupe-by-adoption (`findMarked` against the resource's own prior
 * comments) still protects against a re-post of an ALREADY-POSTED complaint
 * across a restart — it does not help a count that had not yet reached the
 * threshold before the restart.
 */

/** Marker every complaint this module writes starts with — named for the STATE, not the detector. */
export const MARKER = "[butchr:crashloop]";

/** Mirrors every other detector's per-target escalation budget: at most this many complaints per resource per rolling hour. */
const MAX_PER_HOUR = 3;

interface Entry {
  /** Timestamps (ms) of every spawn observed for this id, pruned to the rolling window on each observation. Never persisted. */
  spawnTimes: number[];
  /** Set once a complaint has been posted (or adopted) for this id's CURRENT continuous episode — from then on this id is skipped with no further I/O until it drops out of `desired` (see `forgetMissing`). */
  spokenAt?: number;
}

/**
 * The dedupe/adoption key embedded in `crashLoopComment`'s last line —
 * bracket-delimited on both sides so `findMarked`'s plain substring match
 * (escalation-helper.ts) can never false-match a longer id that happens to
 * share this id as a prefix (`BUTCHR-1` inside `BUTCHR-12`) — see
 * escalation-loop.ts's `paneKey` for the identical reasoning and Rule 2b's
 * "a successful match is not proof it matched the right thing".
 */
function resourceKey(id: string): string {
  return `resource: [${id}]`;
}

/**
 * Per-id in-memory rolling-window spawn count + "already spoken" latch.
 * `recordSpawn` appends a timestamp and returns the pruned, still-in-window
 * array; `forgetMissing` drops tracking for any id no longer in `desired`
 * this poll — see this module's own top comment for why `desired`, never
 * `plan.spawn` presence, is the pruning key.
 */
export class CrashLoopTracker {
  private readonly entries = new Map<string, Entry>();

  /** Drop tracking for every id not in `stillDesired` this poll. */
  forgetMissing(stillDesired: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!stillDesired.has(key)) this.entries.delete(key);
  }

  /** Record a spawn observed for `id` at `at`; returns the timestamps still inside the rolling `windowMs` window (oldest-first). */
  recordSpawn(id: string, at: number, windowMs: number): readonly number[] {
    const e = this.entries.get(id) ?? { spawnTimes: [] };
    if (!this.entries.has(id)) this.entries.set(id, e);
    e.spawnTimes = [...e.spawnTimes, at].filter((t) => at - t < windowMs);
    return e.spawnTimes;
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
 * detector in this epic): the daemon can see state (spawned N times over W)
 * but not intent. Names the resource, how many spawns, over what window, and
 * what a human is being asked to do — epic criterion 3. NOT answerable and
 * must not look answerable: no fingerprint, no `ANSWER` line — proven immune
 * to the real `parseDirective` by test (escalate.ts), not eyeballed.
 */
function crashLoopComment(id: string, count: number, windowMinutes: number): string {
  return [
    `${MARKER} ${id} has been spawned ${count} times in the last ${windowMinutes} minutes — it is being respawned without ever staying up.`,
    "",
    `This is a report, not a suppression: nothing about ${id}'s spawning is being blocked or rate-limited by this comment, and it will keep being spawned on every poll exactly as before. If it cannot succeed on its own (a startup crash, a session-limit refusal that never clears, a swallowed kickoff, a workspace that fails to build), a human should look at why it keeps dying rather than waiting for it to recover unattended.`,
    "",
    resourceKey(id),
  ].join("\n");
}

export interface CrashLoopDetectorDeps {
  now: () => number;
  /** BUTCHR_CRASHLOOP_COUNT — spawns of the same id within the rolling window before the complaint fires. */
  count: number;
  /** BUTCHR_CRASHLOOP_WINDOW_MINUTES — the rolling window, in minutes. */
  windowMinutes: number;
  /** Post through the resource's own channel — never a second Atlassian writer (see src/daemon/index.ts's wiring through speakOnOwnChannel). */
  addComment: (id: string, text: string) => Promise<void>;
  /** Recent comments/complaints on `id`'s own channel, newest-first is fine — see this module's own top comment for why a fetch FAILURE must be distinguishable from "fetched fine, nothing found" (never collapsed into the same branch). */
  comments: (id: string) => Promise<readonly CommentRow[]>;
  log?: (line: string) => void;
}

export interface CrashLoopDetector {
  /**
   * One poll's worth of detection. `spawning` is this poll's `plan.spawn`
   * (src/reconcile/plan.ts) exactly as `reconcileNow` computed it — never
   * filtered or delayed by this call. `desired` is `desired.keys()` from the
   * SAME poll, used only for pruning (see this module's own top comment).
   * Returns nothing and is never consulted for control flow — see the
   * audible-only ruling above. Never throws.
   */
  check: (spawning: readonly string[], desired: readonly string[]) => Promise<void>;
}

/** Builds the crash-loop detector wired into `reconcileNow`'s `ReconcileOptions.checkCrashLoop` (src/daemon/loop.ts), called before the spawn loop runs. */
export function createCrashLoopDetector(deps: CrashLoopDetectorDeps): CrashLoopDetector {
  const tracker = new CrashLoopTracker();
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  // One "rate cap reached" WARNING per id until it frees up — mirrors every
  // other detector's `cappedLogged`, same reasoning: without this a
  // permanently-capped id would log once per poll forever.
  const cappedLogged = new Set<string>();
  // One "fleet-wide, not counted" WARNING per SUSTAINED occurrence, not one
  // per poll — mirrors `cappedLogged` just above (and `parked.ts`/
  // `labels/pr.ts`'s named "a PERMANENT throttle logs once instead of once
  // per poll" convention): without this, the persistent-condition case this
  // module's own top comment now discloses (a whole small fleet
  // crash-looping simultaneously) would log an identical line on every
  // single poll for as long as it lasts — hours of `WARNING` noise for one
  // fact. Cleared the moment the condition stops holding, so a LATER
  // recurrence logs again rather than staying silently suppressed forever.
  let fleetWideLogged = false;
  const windowMs = deps.windowMinutes * 60_000;
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) complaint for `id`. Returns the time
   * it was posted/adopted, or null when nothing changed this poll (a failed
   * fetch, or the rate cap) — null means "not written this poll, try again
   * next time", never "reap it anyway" (there is nothing to reap — this
   * module never gates a spawn).
   */
  async function postComplaint(id: string, count: number): Promise<number | null> {
    const rows = await deps.comments(id).catch((e) => {
      log(`WARNING: [crashloop] comments fetch failed for ${id}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    // COULD NOT CHECK vs. CHECKED, FOUND NOTHING — never the same branch (see
    // this module's own top comment and Rule 2a): `rows === null` here can
    // only mean the former.
    if (rows === null) return null;
    const existing = findMarked(rows, MARKER, [resourceKey(id)]);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      log(`[crashloop] adopted existing complaint for ${id} from comment ${existing.id} (daemon restart)`);
      return adoptedAt;
    }
    if (!rateCap.allow(id, deps.now())) {
      if (!cappedLogged.has(id)) {
        cappedLogged.add(id);
        log(`WARNING: [crashloop] rate cap reached (${MAX_PER_HOUR}/hour) for ${id} — complaint logged only, not posted (further cap hits for ${id} are logged only once until it frees up)`);
      }
      return null;
    }
    await deps.addComment(id, crashLoopComment(id, count, deps.windowMinutes));
    rateCap.record(id, deps.now());
    cappedLogged.delete(id);
    const postedAt = deps.now();
    log(`[crashloop] ${id} spawned ${count} times in ${deps.windowMinutes}m — complaint posted`);
    return postedAt;
  }

  async function check(spawning: readonly string[], desired: readonly string[]): Promise<void> {
    try {
      tracker.forgetMissing(new Set(desired));
      // THE INVERTED CONFIDENT-ZERO HAZARD (epic criterion 9, this module's
      // own top comment): a poll where `plan.spawn` is EXACTLY the ENTIRE
      // desired set is evidence herdr reported nothing running, not evidence
      // every one of those resources is individually crash-looping.
      // Requiring more than one desired resource keeps a genuinely
      // single-resource fleet's own real crash loop detectable (there is no
      // way to distinguish the two cases with only one candidate, and the
      // alternative — never detecting a solo crash loop — is strictly
      // worse); this poll's spawns are not recorded toward any id's window
      // at all when it fires.
      //
      // DISCLOSED LIMITATION, NOT MERELY A DELAY (see this module's own top
      // comment): for a TRANSIENT herdr blip this only delays detection,
      // same as a daemon restart. For a PERSISTENT common-cause fleet-wide
      // crash loop (this guard's own condition holding on every poll for as
      // long as the whole fleet stays down) it suppresses the alarm
      // INDEFINITELY — a deliberate trade-off against fanning a complaint
      // out to every ticket at once, not an oversight.
      const fleetWide = desired.length > 1 && spawning.length === desired.length;
      if (fleetWide) {
        if (!fleetWideLogged) {
          fleetWideLogged = true;
          log(`WARNING: [crashloop] the entire desired set (${spawning.length}/${desired.length}) is in plan.spawn this poll — treating as herdr reporting nothing running rather than a fleet-wide crash loop; this poll's spawns are not counted (logged once until this clears — see this module's own top comment: a SUSTAINED occurrence of this is a disclosed, indefinite suppression, not merely a delay)`);
        }
        return;
      }
      fleetWideLogged = false; // condition cleared this poll — a later recurrence logs again
      for (const id of spawning) {
        const times = tracker.recordSpawn(id, deps.now(), windowMs);
        if (tracker.isSpoken(id)) continue;
        if (times.length < deps.count) continue;
        const at = await postComplaint(id, times.length);
        if (at !== null) tracker.markSpoken(id, at);
      }
    } catch (e) {
      log(`WARNING: [crashloop] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
