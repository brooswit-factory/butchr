import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-95/123 — bounding `atRest` in time. `planReconcile`'s `atRest`
 * guard (src/reconcile/plan.ts) exists to protect a genuine race: a woken
 * agent's last two acts are advance-watermark then exit, and a poll landing
 * between those two acts reads the resource as `"asleep"` (BUTCHR-66/83's
 * `Activation<T>` verdict) while its agent is STILL RUNNING. That guard has
 * no time bound of any kind, so an agent that advances its watermark and
 * then never exits — crashed, hung, OOM-killed, waiting forever — occupies
 * the same window PERMANENTLY: nothing reaps it (`stop` subtracts `atRest`
 * unconditionally) and nothing repairs it (`respawn` intersects `desired`,
 * which an asleep resource is never in). It also looks EXACTLY like a
 * healthy sleeping resource from the outside, because rest is that tier's
 * normal state — quiet is evidence of nothing.
 *
 * THE TICKET'S TITLE NAMES TWO SYMPTOMS OF ONE HOLE, NOT TWO HOLES: once a
 * frozen resource is reaped (stopped) by this detector, the ordinary `spawn`
 * path (`spawn = desired − running`) already handles the "still has real
 * work" case correctly on the very next poll — `running` no longer contains
 * it, and if its verdict is genuinely `"active"` again it is simply spawned
 * fresh, same as any other newly-desired resource. `respawn` was never the
 * right mechanism for this case and stays untouched here: `respawn`
 * intersects `desired`, which an asleep resource is never in, so a stale
 * agent on a still-asleep resource was never eligible for it and should not
 * be — respawning a resource with nothing to do would be wrong, not merely
 * unimplemented. The second symptom in the title is DISSOLVED by fixing the
 * first, not separately resolved.
 *
 * SPEAK FIRST, ACT SECOND — NEVER A SILENT REAP (the parent epic's
 * non-negotiable rule): this module's `check` posts an audible, observed
 * complaint on the resource's OWN channel (an issue's ticket, or a
 * project's Confluence root doc — via `speakOnOwnChannel`,
 * src/tools/speak.ts, wired in by the caller) BEFORE ever reporting a
 * resource as no-longer-protected. The caller (`reconcileNow`,
 * src/daemon/loop.ts) only removes an id from `atRest` once this module
 * says so, and this module only ever says so after the complaint has been
 * posted or found already posted (a daemon-restart adoption) — never on a
 * bare timeout. THIS MATTERS MORE THAN USUAL HERE: once the frozen agent is
 * reaped, the resource looks perfectly healthy again — the complaint is the
 * ONLY SURVIVING EVIDENCE that an agent ever froze there at all.
 *
 * THE DEDUPE TRAP, promoted by the epic to a hard requirement (applies to
 * every detector this epic touches, not just this one): "I checked and
 * found nothing to adopt" and "I could not check" must NEVER take the same
 * branch — a detector that collapses the two into "post it" would spam its
 * channel every restart, which is a WORSE outcome than the silence this
 * epic exists to fix, because it destroys the channel's credibility rather
 * than merely failing to use it. `parked.ts` already gets this right (its
 * own fetch-failure `.catch` returns `null`, and its caller bails for that
 * poll rather than treating null as "nothing to adopt") — it is the model
 * this module's `postComplaint` copies. Reading back a resource's own
 * comments to dedupe/adopt is where a PROJECT target specifically needs
 * care: a project key is not addressable as a Jira issue (measured:
 * `GET /rest/api/3/issue/BUTCHR` -> 404 against `BUTCHR-62` -> 200) — and
 * even setting that failure aside, an issue-shaped comments read would
 * still be the WRONG RESOURCE for a project (its speech is a Confluence
 * footer comment on its root doc, not a Jira comment), so the caller's
 * `comments` reader must go through the symmetric page-comment path for a
 * project id, never the issue one (see src/daemon/index.ts's
 * `ownChannelComments` wiring). Getting either half wrong the naive way
 * — failing open on the fetch, or reading the wrong resource even when the
 * fetch "succeeds" — is bounded but repeatedly wrong across every daemon
 * restart, not merely "every poll forever" (the in-memory rate cap does not
 * depend on the read-back), which is the sharper reason it still matters:
 * restart is exactly the moment dedupe-by-adoption exists to handle.
 * `postComplaint` below fails CLOSED on a fetch failure (posts nothing,
 * retries next poll) — the caller supplies a `comments` reader already
 * symmetric with wherever `addComment` actually posts (see
 * src/daemon/index.ts's `ownChannelComments` wiring), so this module itself
 * never has to know which channel shape it's talking to.
 *
 * RULE 2b'S THIRD FORM, LEARNED HERE (BUTCHR-129): even a `comments` reader
 * that hits the right resource with the right call can still hand back the
 * WRONG REPRESENTATION. The project branch of `ownChannelComments` reads
 * through `ops.getPageComments`, which returns raw Confluence
 * storage-format XHTML — a body genuinely present and genuinely the right
 * resource, just wrapped as `<p>...</p>` — so `findMarked`'s
 * `startsWith(marker)` anchor silently never matched on the project tier
 * until BUTCHR-129 made the reader unwrap it first
 * (`unwrapStorageParagraph`, src/tools/speak.ts). Nothing in THIS module
 * could have caught that on its own: `postComplaint` only ever sees
 * whatever `deps.comments` hands it, by design (the paragraph above), so a
 * caller-side representation bug is invisible from here — the next
 * detector that reads a resource's own channel back (BUTCHR-84 included)
 * will hit the same trap unless its own `comments` reader goes through the
 * same unwrap.
 *
 * RESTART BEHAVIOUR, stated rather than left implicit: all tracking here is
 * in-memory only. A daemon restart loses every `firstObservedAt` floor and
 * every in-memory "already spoken" latch. This is SAFE for this detector
 * specifically, because losing the clock can only ever DELAY detection
 * (a fresh floor starts counting from the restart, not from the original
 * freeze), never FABRICATE it, and dedupe-by-adoption (`findMarked` against
 * the resource's own already-posted comments) is exactly what stops a
 * restart from re-posting a complaint it already made in a prior process's
 * lifetime — the same reasoning src/agents/parked.ts and
 * src/agents/stalled.ts already rely on for their own floors.
 *
 * SHAPE LEFT FOR A SECOND CALLER (BUTCHR-84, sequenced after this ticket
 * specifically because it needs the same new thing): `FrozenAsleepTracker`
 * (the floor + latch bookkeeping) and `createFrozenAsleepDetector` (the
 * dedupe/rate-cap/speak wiring around it) are both generic over an opaque
 * string id and a caller-supplied `(addComment, comments)` pair — nothing
 * here assumes `atRest`, sleep, or a project. BUTCHR-84's "a crash-looping
 * agent is respawned every poll, indefinitely and undetected" needs the
 * same durable-enough per-resource floor attached to the loop/reconciler
 * (not the pure verdict) that this module already builds; it would supply
 * its own candidate set (repeatedly-respawned ids, not resting-and-running
 * ones) and its own comment text, reusing this module's tracker/detector
 * shape (or `RateCap`/`findMarked` directly, same as this module does)
 * rather than inventing a second escalation primitive.
 */

/** Marker every complaint this module writes starts with. */
export const MARKER = "[butchr:frozen]";

/** Mirrors parked.ts/escalation-loop.ts's per-target escalation budget: at most this many complaints per resource per hour. */
const MAX_PER_HOUR = 3;

interface Entry {
  /**
   * Daemon's first observation of `id` in the resting-AND-running state — a
   * conservative floor, same reasoning as StalledTracker/ParkedTracker: it
   * can only ever DELAY the complaint (e.g. across a daemon restart, which
   * starts a fresh floor), never fabricate one early. Never persisted.
   */
  firstObservedAt: number;
  /** Set once a complaint has been posted (or adopted from a prior process's comment) for this continuous freeze episode — from then on `id` is reported frozen on every call with no further I/O, until it drops out of the candidate set (see `forgetMissing`). */
  spokenAt?: number;
}

/**
 * Per-id in-memory floor + "already spoken" bookkeeping. `observe` starts
 * the floor the first time an id is seen as a candidate (resting AND
 * running); `forgetMissing` drops tracking for any id no longer a candidate
 * this poll — whether because it actually got stopped (the intended
 * outcome), its agent exited on its own, or it woke up for real — so a
 * LATER freeze of the same id starts a fresh floor rather than inheriting a
 * stale one or, worse, being reported frozen immediately from a latched
 * `spokenAt` that belongs to a previous, unrelated episode.
 */
export class FrozenAsleepTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /** Drop tracking for every id not in `stillCandidates` this poll. */
  forgetMissing(stillCandidates: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!stillCandidates.has(key)) this.entries.delete(key);
  }

  /** This poll's observation for a currently resting-AND-running `id`. */
  observe(id: string): Entry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const fresh: Entry = { firstObservedAt: this.now() };
    this.entries.set(id, fresh);
    return fresh;
  }

  /** Latch `id` as spoken-for as of `at` — only ever called once a complaint has actually posted or been adopted. */
  markSpoken(id: string, at: number): void {
    this.entries.get(id)!.spokenAt = at;
  }
}

/**
 * Deliberately OBSERVATIONAL, not accusatory — same reasoning as
 * parked.ts's comment functions: the daemon can see state (asleep, running,
 * for how long) but not intent, so it reports what it measured and lets the
 * reader draw the conclusion. Names the resource, how long it has been in
 * this state, and what is being done about it (epic criterion 3) — not only
 * a log line.
 */
function frozenComment(id: string, elapsedMinutes: number, boundMinutes: number): string {
  return [
    `${MARKER} ${id} has read "asleep" with its agent still running, continuously, for ${elapsedMinutes} minutes — past the ${boundMinutes}-minute bound \`atRest\` allows for the wake-then-exit race it guards.`,
    "",
    `Its agent is being stopped now. If it genuinely still has work, the ordinary spawn path will bring it back on a later poll once its verdict reads active again — this is a reap, not a respawn: an asleep resource has nothing queued for it right now.`,
    "",
    `fingerprint: ${id}`,
  ].join("\n");
}

export interface FrozenAsleepDetectorDeps {
  now: () => number;
  /** BUTCHR_ATREST_MINUTES — minutes a resource must read resting-AND-running, continuously, before it is no longer protected. */
  minutes: number;
  /** Post through the resource's own channel — an issue's ticket, or (via `speakOnOwnChannel`, src/tools/speak.ts) a project's Confluence root doc. Never a second Atlassian writer. */
  addComment: (id: string, text: string) => Promise<void>;
  /** Recent comments/complaints on `id`'s own channel, newest-first is fine — see this module's own doc comment for why a fetch FAILURE must be distinguishable from "fetched fine, nothing found" (never collapsed into the same branch). */
  comments: (id: string) => Promise<readonly CommentRow[]>;
  log?: (line: string) => void;
}

export interface FrozenAsleepDetector {
  /**
   * One poll's worth of detection over the ids that are CURRENTLY both
   * `atRest` and running (the caller — `reconcileNow`, src/daemon/loop.ts —
   * computes this intersection, since it already has both sets). Returns
   * the ids that are no longer protected this poll: EITHER a complaint was
   * just posted or adopted, OR one already was on a prior call for this
   * same continuous episode. An id inside its bound, or one whose complaint
   * could not be posted this poll (a rate cap or a failed comments fetch —
   * see this module's own doc comment), is simply absent from the result —
   * still fully protected, never a partial or silent reap. Never throws.
   */
  check: (restingRunning: readonly string[]) => Promise<ReadonlySet<string>>;
}

/**
 * Builds the frozen-asleep detector wired into `reconcileNow`'s
 * `ReconcileOptions.checkFrozenAsleep` (src/daemon/loop.ts), which removes
 * whatever this returns from the `atRest` set actually handed to
 * `planReconcile` — landing a newly-frozen id in `stop` the very same poll
 * (never `respawn`; see this module's top comment for why that asymmetry is
 * correct).
 */
export function createFrozenAsleepDetector(deps: FrozenAsleepDetectorDeps): FrozenAsleepDetector {
  const tracker = new FrozenAsleepTracker(deps.now);
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  // One "rate cap reached" WARNING per id until it frees up — mirrors
  // parked.ts's `cappedLogged`, same reasoning: without this a permanently
  // capped id would log once per poll forever.
  const cappedLogged = new Set<string>();
  const minutesMs = deps.minutes * 60_000;
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) complaint for `id`. Returns the time
   * it was posted/adopted, or null when nothing changed this poll (a failed
   * fetch, or the rate cap) — null means "stays protected, try again next
   * poll", never "reap it anyway".
   */
  async function postComplaint(id: string, elapsedMinutes: number): Promise<number | null> {
    const rows = await deps.comments(id).catch((e) => {
      log(`WARNING: [frozen] comments fetch failed for ${id}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    // COULD NOT CHECK: a distinct branch from "checked, found nothing" right
    // below — collapsing the two would either re-post on every failed fetch
    // (this branch is reached instead) or, worse, silently reap on one (it
    // is not: returning null here never enters "adopted or posted").
    if (rows === null) return null;
    const existing = findMarked(rows, MARKER, [`fingerprint: ${id}`]);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      log(`[frozen] adopted existing complaint for ${id} from comment ${existing.id} (daemon restart)`);
      return adoptedAt;
    }
    if (!rateCap.allow(id, deps.now())) {
      if (!cappedLogged.has(id)) {
        cappedLogged.add(id);
        log(`WARNING: [frozen] rate cap reached (${MAX_PER_HOUR}/hour) for ${id} — complaint logged only, not posted (further cap hits for ${id} are logged only once until it frees up)`);
      }
      return null;
    }
    await deps.addComment(id, frozenComment(id, elapsedMinutes, deps.minutes));
    rateCap.record(id, deps.now());
    cappedLogged.delete(id);
    const postedAt = deps.now();
    log(`[frozen] ${id} past the ${deps.minutes}-minute atRest bound (${elapsedMinutes}m) — complaint posted, no longer protected`);
    return postedAt;
  }

  async function check(restingRunning: readonly string[]): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    try {
      tracker.forgetMissing(new Set(restingRunning));
      for (const id of restingRunning) {
        const e = tracker.observe(id);
        if (e.spokenAt !== undefined) {
          out.add(id);
          continue;
        }
        const now = deps.now();
        // THE RACE THE GUARD EXISTS FOR: strictly less than the bound means
        // leave alone, in both directions, and say NOTHING — no comment, no
        // log line above the ordinary poll trace. This is what keeps a
        // genuine wake-then-exit (milliseconds to seconds) indistinguishable
        // from silence, exactly as it must be.
        if (now - e.firstObservedAt < minutesMs) continue;
        const elapsedMinutes = Math.round((now - e.firstObservedAt) / 60_000);
        const at = await postComplaint(id, elapsedMinutes);
        if (at !== null) {
          tracker.markSpoken(id, at);
          out.add(id);
        }
      }
    } catch (e) {
      log(`WARNING: [frozen] detector error: ${(e as Error)?.message ?? e}`);
    }
    return out;
  }

  return { check };
}
