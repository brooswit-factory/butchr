import type { ResidencyVerdict } from "./residency-census.js";
export type { ResidencyVerdict } from "./residency-census.js";

/** Marker for greppability — consistent with the existing `[reconcile]`/`[crashloop]`/`[reap]` lines. */
const TAG = "[residency]";

/**
 * BUTCHR-287: how many consecutive suspicious-and-unknown polls a candidate
 * is withheld before this guard gives up and spawns it anyway. See
 * `filter`'s own doc comment for why an unbounded withhold here would be
 * its own liveness hazard — same "must never freeze the fleet forever"
 * rule the ticket states for this whole guard. Not persisted (this
 * tracker's own state resets on a daemon restart, same as
 * `RespawnGuard`/`CrashLoopTracker`/`ReapGuard`) — that is fine BECAUSE the
 * census itself needs no prior state to be correct (it is a live read
 * every poll); this bound exists only to stop a PERSISTENT census failure
 * (herdr up but `pane.list`/`processInfo` reliably erroring) from
 * withholding one ticket's spawn forever while the suspicious condition
 * holds. Not configurable via env — same "plain constant, documented, not
 * a knob" precedent as `RESPAWN_SUPPRESS_POLLS` (loop.ts) and
 * `GRACE_MS`/`GRACE_OBSERVATIONS` (reap.ts).
 */
const UNKNOWN_WITHHOLD_MAX_POLLS = 3;

export interface ResidencyGuardDeps {
  /**
   * Live per-issue census over EXACTLY `candidates` — `HerdrHerd.residency()`
   * (herd.ts). Called once per `filter()` call with that poll's
   * `plan.spawn`, nothing more, nothing less (design note 1: cost
   * proportional to the spawn list).
   */
  census: (candidates: readonly string[]) => Promise<ReadonlyMap<string, ResidencyVerdict>>;
  log?: (line: string) => void;
}

export interface ResidencyGuard {
  /**
   * One poll's worth of the guard. `spawning` is `reconcileNow`'s own
   * `plan.spawn`, exactly as `planReconcile` computed it; `desired` is
   * `desired.keys()` from the same poll — used only for the same
   * fleet-wide-blind discriminator `crash-loop.ts`'s own `check` already
   * computes as `fleetWide` (BUTCHR-141). COPIED here, not imported: the
   * two detectors must stay independently correct even if one is ever
   * removed or its condition retuned — this guard is a separate mechanism
   * from crash-loop detection (design note 9), and sharing the predicate
   * by reference would couple an audible-only detector to a spawn-gating
   * one for no real benefit, only accidental coupling.
   *
   * Returns the subset of `spawning` to ACTUALLY hand to `herd.spawn` this
   * poll. A withheld id is skipped THIS POLL ONLY — it is never removed
   * from `desired`, so `planReconcile` offers it again next poll exactly
   * as before (design note 3 / the BUTCHR-218 liveness trap this ticket's
   * own DoD names explicitly: a guard that achieves safety by shrinking
   * the desired set strands a ticket forever; this one only ever narrows
   * one poll's `plan.spawn`).
   */
  filter: (spawning: readonly string[], desired: readonly string[]) => Promise<readonly string[]>;
}

/** Builds the residency guard wired into `reconcileNow`'s `ReconcileOptions.checkResidency` (src/daemon/loop.ts), called immediately after `planReconcile` — BEFORE `opts.admission`, `checkCrashLoop`, `checkReap` and the spawn loop, all of which see its output rather than `plan.spawn`. (Read the call order off loop.ts itself, not off this line: an earlier version of this comment said "after `checkReap`", which loop.test.ts's own ordering assertion already contradicted.) */
export function createResidencyGuard(deps: ResidencyGuardDeps): ResidencyGuard {
  const unknownStreak = new Map<string, number>();
  const log = (line: string) => deps.log?.(line);

  async function filter(spawning: readonly string[], desired: readonly string[]): Promise<readonly string[]> {
    // PRUNE FIRST (review finding, PR #310): every tracked id that is NOT a
    // candidate this poll. Without this, an id withheld at streak 1..N-1 that
    // then leaves `desired` — its ticket finished, or it was spawned — keeps a
    // stale entry forever, and if that key ever returns during a later
    // fleet-wide-unknown episode it resumes from the stale count and decays
    // early. Bounded by ticket count and it errs toward spawning rather than
    // withholding, so this is a leak and a weakening of a deliberately-bounded
    // mitigation rather than a safety hole — but neither belongs in a guard
    // whose whole contract is "withhold for a BOUNDED number of CONSECUTIVE
    // polls".
    //
    // PRUNING ON `spawning` IS CORRECT HERE, AND IS DELIBERATELY NOT WHAT
    // crash-loop.ts's `forgetMissing` DOES (that one prunes on `desired`, and
    // its own top comment explains why pruning on plan.spawn absence would
    // silently reset its counter and disable the alarm). The difference is
    // what each counter means: this streak counts CONSECUTIVE polls in which
    // this candidate was withheld as unknown-under-suspicion, and a withheld
    // candidate necessarily reappears in the next poll's `plan.spawn` (it was
    // never spawned, and `desired` is never shrunk — see `filter`'s own doc
    // comment). So absence from `spawning` means the run genuinely ended:
    // either it got spawned, or its ticket left the active statuses. Resetting
    // there is the semantics, not merely the cleanup.
    for (const id of [...unknownStreak.keys()]) if (!spawning.includes(id)) unknownStreak.delete(id);
    if (!spawning.length) return spawning;
    // FAIL-OPEN, DELIBERATELY: a guard that itself fails must never become
    // a liveness hazard bigger than the duplicate-spawn hazard it exists to
    // close — a rejected census this poll changes nothing, exactly as if
    // this hook were omitted. Every candidate's streak is cleared too: a
    // transient census failure must not silently accumulate toward the
    // unknown-decay bound below while producing no verdict to explain why.
    const verdicts = await deps.census(spawning).catch((e) => {
      log(`WARNING: ${TAG} census failed for this poll's ${spawning.length} candidate(s): ${(e as Error)?.message ?? e} — spawning all of them (a failed guard must never itself become a liveness hazard)`);
      return null;
    });
    if (verdicts === null) {
      for (const id of spawning) unknownStreak.delete(id);
      return spawning;
    }
    // BUTCHR-141's own `fleetWide` shape, copied not imported — see this
    // module's own top comment / `ResidencyGuard.filter`'s doc comment.
    const fleetWide = desired.length > 1 && spawning.length === desired.length;
    const out: string[] = [];
    for (const id of spawning) {
      const verdict = verdicts.get(id) ?? "unknown";
      if (verdict === "vacant") {
        unknownStreak.delete(id);
        out.push(id);
        continue;
      }
      if (verdict === "resident") {
        unknownStreak.delete(id);
        log(`[residency] withholding spawn for ${id} this poll — a live claude already occupies its own workspace directory, independent of agent.list() (which reported it not running)`);
        continue;
      }
      // verdict === "unknown"
      if (!fleetWide) {
        // Not under suspicion: an isolated unknown reading preserves
        // liveness rather than ever risking a stall over it (design note 5,
        // "unknown ⇒ spawn" branch — the default outside the suspicious
        // condition).
        unknownStreak.delete(id);
        out.push(id);
        continue;
      }
      const streak = (unknownStreak.get(id) ?? 0) + 1;
      if (streak > UNKNOWN_WITHHOLD_MAX_POLLS) {
        log(`WARNING: ${TAG} ${id} residency has been UNKNOWN for more than ${UNKNOWN_WITHHOLD_MAX_POLLS} consecutive suspicious polls — decaying to normal behaviour and spawning anyway (a persistent census failure must not freeze this ticket forever)`);
        unknownStreak.delete(id);
        out.push(id);
        continue;
      }
      unknownStreak.set(id, streak);
      log(`WARNING: ${TAG} withholding spawn for ${id} this poll — residency UNKNOWN while the whole desired set (${spawning.length}/${desired.length}) is in plan.spawn this poll (suspicious of a blind agent.list() read); withhold ${streak}/${UNKNOWN_WITHHOLD_MAX_POLLS} before this decays`);
    }
    return out;
  }

  return { filter };
}
