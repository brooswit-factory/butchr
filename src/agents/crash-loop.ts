import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";
import type { OpsAlertRouter } from "./ops-alert.js";

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
    `${MARKER} ${id} has been spawned ${count} times in the last ${windowMinutes} minutes.`,
    "",
    `This is a report, not a suppression: nothing about ${id}'s spawning is being blocked or rate-limited by this comment, and it will keep being spawned on every poll exactly as before. Whatever the cause (a startup crash, a session-limit refusal that never clears, a swallowed kickoff, a workspace that fails to build), a human should look at why it keeps being spawned rather than waiting for the pattern to stop unattended.`,
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
  /**
   * FACTORY-622 — the PUSH half of this detector, for a tier whose
   * `addComment` has nowhere to go.
   *
   * THE DEFECT. A managed session (director, genius, an admin agent) has no
   * Jira ticket at all, so `src/daemon/index.ts` wires its instance's
   * `addComment` to a `console.error` and its `comments` to `[]` — see that
   * wiring's own comment. The complaint is therefore CORRECT and completely
   * invisible: measured twice, on 2026-10-02 (director and genius, 5+
   * spawns/hour each, "nowhere to post") and again on 2026-10-03
   * (admin-brooswit-nexus, 26 refusals, "a crash-loop complaint that reached
   * only the journal"). Both times a human found out by reading a journal on
   * the right host, which is the exact pull-only failure `./ops-alert.ts`
   * exists to fix, and which that module's own header already names this
   * detector as the planned caller for.
   *
   * A THUNK, NOT THE ROUTER ITSELF, and this is the only reason why: both
   * detector instances are module-level `const`s in `src/daemon/index.ts`
   * built several hundred lines BEFORE the Rocket.Chat credential the router
   * is constructed from is even loaded. Taking the router by value would
   * force that whole chain to move earlier (it is depended on in between) or
   * read it in its temporal dead zone. Resolved per raise instead, which
   * also costs nothing: `raise` is itself cheap and synchronous.
   *
   * Absent — the ordinary state for a tier that HAS a ticket to comment on —
   * nothing about this detector changes. It is deliberately NOT wired into
   * the issue tier: that tier's complaint lands on the resource's own Jira
   * ticket where the people who care already look, and duplicating it into a
   * shared room is the "spam destroys a channel's credibility" outcome this
   * module's own top comment ranks worse than silence.
   */
  opsAlert?: () => OpsAlertRouter | undefined;
  /**
   * FACTORY-622: why `id`'s last spawn attempt did not leave an agent
   * running — `HerdrHerd.lastSpawnRefusal` (src/agents/herd.ts), which is
   * non-destructive precisely so this can be read on every poll. Named in
   * the ops alert, because "spawned 5 times in 60 minutes" tells a human
   * there is a loop but not what to do about it, whereas "Current worker
   * disappeared; refusing implicit replacement" names the condition
   * outright. `undefined` whenever nothing refused the last attempt (the
   * agent died AFTER a successful launch, say) — the alert then says so
   * rather than inventing a reason.
   */
  refusalReason?: (id: string) => string | undefined;
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

  /**
   * FACTORY-622: push this crash loop to the ops-alert route. Synchronous
   * and never throws — `raise` is both by contract, and a detector that
   * crashed on a posting problem would lose the journal line that was
   * already working. No-ops when no router is wired (the issue tier, and any
   * daemon with no posting credential: the router itself degrades to a
   * journal line there, so this still needs no branch of its own).
   *
   * NO SECRETS, structurally rather than by inspection: the three live values
   * interpolated here are an agent id, an integer, and the refusal string
   * from `ManagedHerdrResult.reason` — and `reason` is the one field
   * `opsAlertMessage` passes through `quoteField(..., { redactSecrets: true })`
   * (see `./ops-alert.ts`), which redacts BEFORE truncating so a secret
   * cannot straddle the cut. Nothing here reads a token file, an env var, or
   * an argv.
   */
  function raiseOpsAlert(id: string, count: number): void {
    try {
      raiseOpsAlertOrThrow(id, count);
    } catch (e) {
      // `check`'s own outer try/catch would also swallow this, but it would
      // swallow the REST OF THE POLL with it: the `for` loop that calls this
      // would abort, so an id after this one never gets its complaint, and
      // neither does this one. The new channel must never be able to cost the
      // journal channel that was already working — caught here, per id, so
      // every other id's complaint still lands.
      log(`WARNING: [crashloop] ops alert for ${id} could not be raised: ${(e as Error)?.message ?? e}`);
    }
  }

  function raiseOpsAlertOrThrow(id: string, count: number): void {
    const router = deps.opsAlert?.();
    if (!router) return;
    const refusal = deps.refusalReason?.(id);
    router.raise({
      // Per session, per condition — the granularity the director's "one
      // deduplicated post per session per hour" names. NOT keyed on the
      // reason or the count: both change while the same loop runs, and a key
      // that moved with them would post on every change instead of once.
      key: `crashloop:${id}`,
      condition: "crashloop",
      subject: `${id} has been spawned ${count} times in the last ${deps.windowMinutes} minutes and has no ticket to report it on`,
      reason: refusal
        ? `last spawn attempt was refused: ${refusal}`
        : "the last spawn attempt was not refused — the agent is dying after a successful launch, so there is no refusal reason to quote",
      remedy:
        `Look at why ${id} keeps being spawned. Nothing is suppressing or rate-limiting its spawning: ` +
        `it will keep being retried on every poll exactly as before, and butchr will not stop on its own.`,
    });
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
        if (times.length < deps.count) continue;
        // FACTORY-622: raised BEFORE the `isSpoken` latch below, and
        // therefore on EVERY poll past the threshold — deliberately, for two
        // reasons that both come straight from the measured incidents.
        //
        // First, the latch and the room are answering different questions.
        // The latch exists so one episode produces one COMMENT; the room's
        // own hourly dedup (`OpsAlertRouter.raise`, whose doc says in as many
        // words that it is safe to call on every poll and that the window,
        // not the caller, decides what posts) exists so one ongoing condition
        // produces one POST per hour. Gating the raise on the latch would
        // hand the room's dedup decision to the comment path.
        //
        // Second, and this is the actual defect: on the tier that needs this
        // most, the comment path CANNOT SUCCEED. `postComplaint` returns null
        // for a failed `comments` fetch and for a rate-cap hit, and the
        // ticketless wiring's `comments` is a constant `[]` with an
        // `addComment` that only logs. An alert gated on that path would be
        // silent in exactly the case it was added for.
        raiseOpsAlert(id, times.length);
        if (tracker.isSpoken(id)) continue;
        const at = await postComplaint(id, times.length);
        if (at !== null) tracker.markSpoken(id, at);
      }
    } catch (e) {
      log(`WARNING: [crashloop] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
