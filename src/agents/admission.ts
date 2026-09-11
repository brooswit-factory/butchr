/**
 * BUTCHR-284 — the fleet-wide admission cap: bounds how many agents this
 * DAEMON keeps RESIDENT at once. Never a memory-headroom watermark (a
 * watermark reads memory as free at t=0, right when a post-reboot stampede
 * would admit the whole fleet before any of it has allocated anything — see
 * the design ruling on the ticket) and never per-project quotas (a fairness
 * mechanism, not a capacity one). Never the spawn FAN-OUT WIDTH either
 * (BUTCHR-117/BUTCHR-242 ruled that a separate, settled question — see
 * `reconcileNow`'s own `Promise.all` over `plan.spawn`, untouched here): this
 * module decides HOW MANY of this poll's spawn candidates are allowed to
 * proceed, not how many run in parallel once admitted.
 *
 * WITHHOLDING, NOT DROPPING (criterion 3 — the liveness constraint this
 * whole increment lives or dies on, BUTCHR-218's own lesson): this module
 * only ever decides which of THIS POLL's spawn candidates (`plan.spawn`,
 * src/reconcile/plan.ts) fit inside the budget. It never touches `desired`,
 * Jira status, or `plan.stop`/`plan.respawn` — a withheld candidate is
 * simply absent from this poll's admitted list and is reconsidered fresh on
 * the very next poll, exactly like an ordinary `plan.spawn` candidate that
 * just hasn't been reached yet. `stop` can never contain a withheld id
 * either, by construction, independent of anything in this module: a
 * `plan.spawn` candidate is (by `planReconcile`'s own definition) NOT
 * currently running, and `stop` only ever removes ids FROM the running set.
 *
 * A RESPAWN NEVER CONSUMES BUDGET (criterion 4): `reconcileNow`
 * (src/daemon/loop.ts) only ever threads `plan.spawn` through `admit()` —
 * `plan.respawn` (stop-then-spawn of an ALREADY-resident agent, net zero
 * change in residency) never passes through this module at all. Gating a
 * respawn against this cap would let a stale agent be stopped and then
 * refused its own replacement, strictly worse than leaving it stale.
 *
 * FLEET-WIDE, NOT PER-TIER (Trap 1 on the ticket): the `residency` census
 * this module is built over MUST be the raw, UNSCOPED herd's
 * `runningIssues()` — the one `scopedHerd` (src/daemon/loop.ts) wraps, never
 * a `scopedHerd`-wrapped view. A residency count taken from inside one
 * `runResourceLoop`'s own scoped herd would count that tier's own agents
 * only, giving each tier its own independent cap and leaving the HOST
 * unbounded — exactly the defect this ticket exists to close.
 * `src/daemon/index.ts` builds ONE `AdmissionController` over the SAME raw
 * `HerdrHerd` instance both the issue and project loops share, and passes
 * that ONE instance to both `runResourceLoop` calls, so the two tiers draw
 * against one shared budget rather than each getting their own.
 *
 * The two tiers poll at very different cadences (the issue tier's 15s vs.
 * the project tier's `PROJECT_POLL_INTERVAL_MS`, 5 minutes) and each calls
 * `admit()` independently, computing its own budget against a FRESH census
 * taken at that moment — this is a per-poll decision, not a running ledger.
 * Two loops consulting the same shared budget can therefore each admit up
 * to it before either's spawns actually land, so a transient overshoot of a
 * few agents past the cap is possible. This is deliberate, not an oversight:
 * a cross-loop ledger would need coordination this codebase's existing
 * per-loop-instance state (RespawnGuard, CrashLoopTracker, ReapGuard) has no
 * precedent for, and the overshoot it would prevent is small and self-
 * correcting (the very next poll's census reflects it) — acceptable as long
 * as the default cap carries headroom, which its own doc comment
 * (src/config/config.ts) states plainly.
 *
 * TRAP 2 — A CONFIDENT ZERO ADMITS A STAMPEDE, MEASURED LIVE (BUTCHR-282's
 * own hazard, inverted here): BUTCHR-282's measured condition is a daemon
 * that logged its entire desired set in `plan.spawn` on one poll and spawned
 * anyway, producing six `agent_pane_busy` failures against six tickets that
 * ALREADY had a live agent elsewhere — the census was READABLE, never
 * threw, and simply reported nothing running while nine agents were alive.
 * If THIS module's `residency` dependency can do that, `budget = cap − 0 =
 * cap` admits a full burst at precisely the moment the fleet is least able
 * to take one. Two distinct failure shapes, both handled, never conflated:
 *
 *   (1) `residency()` THROWS — unambiguous: withhold every candidate this
 *       poll, fail safe. Never touches the trust state below at all; a
 *       herdr outage is a different condition from a readable-but-wrong
 *       answer and does not need bounding in time the way (2) does (a
 *       genuinely down herdr already fails the WHOLE poll elsewhere in
 *       `reconcileNow`, via `herd.staleIssues()`/`runningIssues()`
 *       propagating — see that function's own doc comment).
 *
 *   (2) `residency()` RESOLVES to a READABLE ZERO while the LAST TRUSTED
 *       observation was positive — the BUTCHR-282 shape exactly. The naive
 *       predicate `residency === 0 && candidates.length > 0` is WRONG: it
 *       is indistinguishable from a legitimate COLD START (daemon boots,
 *       nothing has spawned yet, N tickets are active) — a guard that
 *       cannot tell the two apart withholds a cold start FOREVER, which is
 *       worse than no guard at all. The discriminator here is independent
 *       of the read it is checking (never "read it again to confirm" — the
 *       same corrupted source could fail the identical way twice): it is
 *       `stopping` — the CALLING tier's own `plan.stop` this same poll,
 *       which comes from Jira's desired-state read, not from herdr's agent
 *       list at all. A drop from a trusted-positive residency to zero is
 *       PLAUSIBLE only when this poll's own plan explains it (it wanted to
 *       stop at least as many as were trusted running); anything narrower
 *       is treated as an untrustworthy read, not a real drop — agents do
 *       not all vanish between polls on their own.
 *
 * BOUNDED IN TIME, THE WAY `atRest` ALREADY IS (frozen-asleep.ts/
 * `atRestMinutes`, src/config/config.ts) — SAME SHAPE, DIFFERENT UNIT:
 * refusing to trust an implausible zero, forever, reintroduces the exact
 * deadlock a naive guard has (a fleet that genuinely empties — every agent
 * legitimately exits with nothing left to explain it via `stopping` this
 * particular poll — would stay withheld permanently). `ImplausibleZeroGuard`
 * below counts CONSECUTIVE implausible reads (not minutes: this controller
 * is shared by two tiers polling at very different cadences, and a poll
 * count is the unit both agree on) and accepts the zero once
 * `MAX_IMPLAUSIBLE_POLLS` is reached — mirroring `RESPAWN_SUPPRESS_POLLS`
 * (src/daemon/loop.ts), the one other poll-counted bound in this codebase.
 * THIS IS A BOUNDED MITIGATION, NOT A FIX FOR BUTCHR-282, AND MUST NOT BE
 * DESCRIBED AS ONE (ticket, Trap 2(e)): it only ever changes what THIS
 * module trusts on the polls it happens to run; BUTCHR-282's own root cause
 * (duplicate spawns against a confidently-empty herdr list) has its own
 * owner and its own fix, out of scope here.
 *
 * BUTCHR-297 — STARVATION-FREE ADMISSION ORDER (AGING): everything above
 * this paragraph predates this ticket and describes the CAP; this paragraph
 * and `orderByWait`/`recordSpawned` below describe the ORDER candidates are
 * admitted in, a previously-out-of-scope FAIRNESS concern this module's own
 * header used to disclaim ("never per-project quotas... a fairness
 * mechanism, not a capacity one"). That disclaimer is now wrong on purpose,
 * not stale: under sustained saturation, bare lexicographic order (the
 * `.sort()` in `planReconcile`, src/reconcile/plan.ts) gave the same
 * candidates the same losing order on every single poll, forever — measured
 * live on two daemons, ~750 polls each, with FIFO/aging/priority/oldest-
 * first all independently refuted (see the ticket for the full falsifier
 * table). WITHHOLDING WAS NEVER THE BUG — the design's own liveness
 * criterion (this file's own "WITHHOLDING, NOT DROPPING" paragraph above)
 * held throughout the entire starved window. Fairness is the property that
 * was missing, and it is now this module's job precisely because nothing
 * else in the reconcile pipeline decides admission ORDER at all.
 *
 * `orderByWait` is a SEPARATE pure function from `admitWithinBudget`,
 * deliberately, for the same reason `admitWithinBudget` already is its own
 * export: unit-testable arithmetic with no census plumbing. It sorts by
 * accumulated wait DESCENDING, tie-broken by the existing lexicographic key
 * ASCENDING — so a cold start or an unsaturated fleet (every candidate at
 * wait 0) reproduces today's exact order byte-for-byte, which is what keeps
 * every pre-existing `admitWithinBudget`/`reconcileNow` test meaningful
 * rather than silently re-baselined by this change.
 *
 * THE LEDGER'S UNIT IS POLLS, NOT TIME — same reasoning `ImplausibleZeroGuard`
 * already gives for itself, above: this controller is ONE instance SHARED
 * by two tiers polling at very different cadences (the issue tier's 15s vs.
 * the project tier's 5min, Trap 1's own point), so a wall-clock duration
 * would mean two different things depending on which tier's candidate last
 * touched it. A poll (one `admit()` call that actually reaches the ordering
 * logic below — see the empty-candidates early return, which is correct to
 * skip this entirely: an empty candidate list is not evidence about
 * anyone's wait) is the one unit both tiers already agree on.
 *
 * B1 — ONE SHARED LEDGER, TWO DISJOINT CANDIDATE SETS: `src/daemon/index.ts`
 * passes this SAME controller instance to both `runResourceLoop` calls (see
 * this file's own Trap-1 paragraph above for why the CAP must be fleet-wide
 * — the ORDER must be too, for the identical reason: two independent
 * per-tier ledgers would let one tier's candidate starve behind a wait count
 * that only ever advances on the OTHER tier's cadence). The two tiers' own
 * candidate sets are disjoint (an issue id never appears in the project
 * tier's `plan.spawn` and vice versa), so the ledger must never treat "not
 * in THIS call's candidates" as "no longer wanted" — that would have the
 * project tier's ~5-minute poll silently zero out everything the issue
 * tier's own 15-second polls had been accumulating, roughly twenty times
 * per project poll, with no error and no failing test unless one is written
 * for exactly this (see test/unit/admission.test.ts's own B1 case). The
 * fix is structural, not a guard: a candidate's wait is only ever touched
 * by CODE PATHS THAT RECEIVED IT AS AN ARGUMENT THIS CALL (the withheld/
 * admitted loops below) — a key absent from `candidates` is never iterated
 * at all, so there is no branch that COULD zero it.
 *
 * B2 — BOUNDED, BUT NEVER BY "CLEAR WHAT'S ABSENT": a candidate that
 * genuinely stops being desired (ticket leaves the active set) never
 * reappears in ANY tier's candidate list again, and would otherwise leak in
 * this ledger forever. The bound here is EVICT-AFTER-UNSEEN
 * (`LEDGER_UNSEEN_EVICTION_CALLS` below), not a per-call absence check (that
 * would just be B1's bug again) — a candidate's `lastSeenCall` is refreshed
 * every call it appears in as EITHER withheld or admitted-with-a-leftover-
 * wait (see B4 immediately below for why an admitted id can still carry a
 * nonzero wait), and only evicted once it has gone unseen, across BOTH
 * tiers' calls combined, for longer than the bound. Sized generously above
 * the natural gap between two consecutive appearances of a genuinely
 * still-desired candidate — including the project tier's own ~20x-longer
 * polling interval relative to the issue tier sharing this same call
 * counter, and the immediate re-offer after a failed spawn (B4) — so this
 * bound only ever reclaims a candidate that has truly left `desired` for
 * good. NOT proven never to fire too early under some pathological gap this
 * ticket didn't measure — the residual this leaves open, named rather than
 * hidden.
 *
 * B3 — THE TWO FAIL-SAFE PATHS NEVER TOUCH THIS LEDGER EITHER: both
 * `residency()`-throws and the untrusted-implausible-zero branch above
 * `return []` BEFORE `lastTrusted` is even updated, let alone before the
 * ordering/ledger block further down — so a herdr outage or an untrusted
 * census can never advance, decrement, or evict anything in `waits`. Their
 * own doc comments above already promise this for the trust state
 * (`lastTrusted`); the wait ledger and `lastWithheld` (the `/health` seam,
 * see `AdmissionSnapshot.longestWait` below) now share that same promise,
 * for the same reason: a read this module does not trust is not evidence
 * about anyone's wait either.
 *
 * B4 — ⚠ CLEARED ON A SUCCEEDED SPAWN, NEVER ON ADMISSION: admission and
 * running are DIFFERENT EVENTS. A candidate can be admitted, then fail to
 * spawn (`agent_pane_busy`, or the create-then-start readiness race —
 * measured at a 24-29% per-attempt failure rate, and reproduced live on
 * this exact ticket's own first three admissions before this fix existed to
 * protect it) and return next poll at the BACK of the queue having never
 * run, if the wait counter were cleared on admission instead. That failure
 * is INVISIBLE: a successful spawn writes no journal line, and a reset
 * counter looks exactly like a fresh arrival — nothing would show a ticket
 * being starved by the very mechanism built to prevent starvation.
 * `recordSpawned` below is the only thing that ever clears an entry, and it
 * must only ever be called with ids whose `herd.spawn()` call already
 * RESOLVED — `reconcileNow`'s own `admitted.map(...).catch(...)` (src/
 * daemon/loop.ts) already computes exactly this set (`admitted` minus the
 * ids recorded into `failures` with `stage: "spawn"`; a `"respawn"`-staged
 * failure is a different code path — see `planReconcile`'s own respawn
 * comment — and can never contaminate it). NOT THE SAME CLAIM AS "the agent
 * is alive" (BUTCHR-282's own subject): `herd.spawn()` resolving is not
 * proof of a live agent, only proof an attempt was made without throwing —
 * "cleared on spawn success" is narrower than "cleared once it ran", and
 * B2's eviction bound above is the backstop for the gap between those two,
 * not a claim that this closes it.
 */

/** Mirrors `RESPAWN_SUPPRESS_POLLS`'s own reasoning (src/daemon/loop.ts) and this codebase's existing 4x-multiple convention (`pollStaleMs`/`PROJECT_POLL_STALE_MS`, src/daemon/index.ts): long enough to absorb a transient herdr hiccup spanning a few polls of EITHER tier, short enough that a genuinely-draining fleet is not falsely withheld for long. */
export const MAX_IMPLAUSIBLE_POLLS = 4;

/**
 * BUTCHR-320 criterion (D) — a LEGIBLE DISCONTINUITY against TWO prior
 * formats, both still `[admission]`-tagged and both guarded on
 * `withheld > 0` (never fired at `withheld = 0`):
 *
 *   Format 1 (the build in production as of BUTCHR-320's own writing,
 *   `0fa49429`): `[admission] cap=13 residency=13 withheld 2/2 wanted:
 *   BUTCHR-307, BUTCHR-308` — a bare comma-separated id list.
 *
 *   Format 2 (main since BUTCHR-297's aging merge, and this file's own emit
 *   immediately below before this ticket): `[admission] cap=13 residency=13
 *   withheld 2/2 wanted: BUTCHR-307(4), BUTCHR-308(2)` — each id carries a
 *   `(count)` wait suffix.
 *
 * Once (B) makes the line fire on `withheld = 0` polls too, a before/after
 * comparison spanning this deploy would show an apparent RISE in admissions
 * that is purely the instrument gaining sight of polls it could not observe
 * before — indistinguishable from a real change unless the reader can tell,
 * from the line's own shape, which instrument produced it. A DISTINCT TAG
 * (not a version marker appended to the same `[admission]` tag) was chosen
 * deliberately: `startsWith("[admission]")` — the exact test both
 * `admission.test.ts` and any external reader would reach for first — must
 * never accidentally match the new line, and a trailing marker (e.g.
 * `[admission] v2 ...`) still starts with the literal substring
 * `"[admission]"` only if a space follows immediately after "admission",
 * which it does NOT here (`[admission] v2` has `[admission]` as an exact
 * prefix) — a hazard a same-tag marker cannot help but risk. A wholly
 * different tag has no such trap. THIS IS NOT BACKWARD COMPATIBILITY (the
 * ticket's own words): the old tag is retired outright, not kept parseable
 * alongside the new one — see `test/unit/admission.test.ts`'s six-direction
 * discontinuity test for the mechanical proof against both prior formats.
 *
 * BEFORE/AFTER COMPARISONS OF ADMISSIONS ACROSS THIS CHANGE MUST BE
 * RE-BASELINED — restated here because this is the module that changed, not
 * only on the ticket's own doc.
 *
 * BUTCHR-334 — "NO LINE THIS POLL" NOW MEANS EXACTLY ONE THING: zero spawn
 * candidates, full stop, true on EVERY path through `admit()` — not only the
 * ordinary one. Before this ticket, `admit()`'s two fail-safe early returns
 * (`residency()` throwing; a readable-but-still-untrusted implausible zero —
 * see this file's own top-comment Trap 2) withheld every candidate but
 * `return`ed before this line was ever reached, so a poll that HAD
 * candidates, all of them withheld by a fail-safe, produced no
 * `[admission2]` line at all — a reader had to already know and remember
 * that caveat. Both paths now also log, under this SAME tag, via
 * `admissionFailSafeLine` (see its own doc comment for the exact shape and
 * why it omits `residency=`) — so the guarantee holds by construction
 * rather than by a caveat a reader has to carry. `admit()`'s return value
 * (always `[]` on both paths) is UNCHANGED by this — this is an emission
 * change only, pinned by test alongside the behavioural pin.
 */
export const ADMISSION2_TAG = "[admission2]";

/**
 * BUTCHR-297 (§B2): how many `admit()` calls (counted across BOTH tiers
 * sharing this one controller instance — see this file's own top-comment
 * addendum for why a call, not a poll of either tier alone, is the unit) a
 * candidate may go unseen before its wait-ledger entry is reclaimed. The
 * issue tier polls roughly 20x more often than the project tier
 * (15s vs. `PROJECT_POLL_INTERVAL_MS` = 5min, src/resources/project.ts) — a
 * still-desired project-tier candidate can therefore go ~20 calls between
 * its own two consecutive appearances even with nothing wrong, so the bound
 * is set generously above several such cycles: large enough that a
 * genuinely still-desired candidate (including one merely between spawn
 * retries, B4) is never mistaken for abandoned, small enough that a
 * candidate that truly left `desired` for good does not leak forever.
 */
export const LEDGER_UNSEEN_EVICTION_CALLS = 200;

/**
 * Tracks whether a readable-zero residency read is still within its
 * bounded-mistrust window. `record()` returns `true` while the streak of
 * consecutive implausible reads is still within `maxPolls` (untrusted —
 * withhold); once the streak EXCEEDS `maxPolls` it returns `false` (the
 * bound is exceeded — accept the zero as real) and resets, so a LATER,
 * fresh episode of implausible reads gets its own full window rather than
 * inheriting an already-exhausted one. `clear()` resets the streak the
 * moment a read is plausible again (trusted, or a legitimate cold start) —
 * an implausible episode that self-resolves does not eat into the budget of
 * a later, unrelated one.
 */
export class ImplausibleZeroGuard {
  private streak = 0;
  constructor(private readonly maxPolls: number = MAX_IMPLAUSIBLE_POLLS) {}

  /** Record one more consecutive implausible read; true while still within the bound (untrusted), false once the bound is exceeded (accept it — and the streak resets). */
  record(): boolean {
    this.streak++;
    if (this.streak > this.maxPolls) {
      this.streak = 0;
      return false;
    }
    return true;
  }

  /** How many consecutive implausible reads have been recorded so far (for the log line) — reflects the count BEFORE any reset `record()` just performed. */
  get currentStreak(): number {
    return this.streak;
  }

  /** A plausible read (trusted positive/zero, or a legitimate cold start) clears the streak entirely. */
  clear(): void {
    this.streak = 0;
  }
}

export interface AdmissionSnapshot {
  /** BUTCHR_MAX_AGENTS — see src/config/config.ts for the derivation. */
  cap: number;
  /** Last successfully TRUSTED fleet-wide residency count, or null before any trusted observation (nothing has polled yet). An implausible read never updates this. */
  residency: number | null;
  /**
   * BUTCHR-297: the currently-withheld candidate with the highest
   * accumulated wait, or null when nothing is withheld. Deliberately never
   * flips `ok` (see `combineHealth`'s own doc comment, src/daemon/health.ts
   * — this is a THIRD sibling alongside `build`/`coverage`/this field's own
   * `residency`): sitting at the cap with a long-withheld candidate is a
   * normal, healthy, EXPECTED state under saturation, not a liveness fault.
   * Needs no separate "never observed" marker distinct from `null`: this is
   * only ever computed alongside `residency` on the SAME trusted path (see
   * B3 above — neither field updates on a fail-safe path), so
   * `residency === null` already means "no trusted census yet" and
   * `residency: <number>, longestWait: null` unambiguously means "observed,
   * and nothing is currently withheld" — the same discriminator `residency`
   * itself already uses against a bare `0`, extended to this field rather
   * than duplicated.
   */
  longestWait: { id: string; polls: number } | null;
}

export interface AdmissionControllerDeps {
  /** BUTCHR_MAX_AGENTS. */
  cap: number;
  /**
   * The fleet-wide residency census — MUST be the raw, unscoped herd's
   * `runningIssues()` (see this module's own top comment, Trap 1), never a
   * `scopedHerd`-wrapped view. Returns every currently-running agent id,
   * regardless of resource type.
   */
  residency: () => Promise<readonly string[]>;
  /** Poll-count bound for a readable-but-implausible zero — see `ImplausibleZeroGuard`. Optional; defaults to `MAX_IMPLAUSIBLE_POLLS`. */
  maxImplausiblePolls?: number;
  log?: (line: string) => void;
}

export interface AdmissionController {
  /**
   * One poll's worth of admission for ONE tier's `plan.spawn` (`candidates`,
   * already sorted in `planReconcile`'s deterministic order — admitted from
   * the front) and that SAME tier's `plan.stop` (`stopping`, used only as
   * the cold-start/implausible-zero discriminator — see this module's own
   * top comment, Trap 2). Never throws.
   */
  admit(candidates: readonly string[], stopping: readonly string[]): Promise<readonly string[]>;
  /** Current snapshot for `/health` — see AdmissionSnapshot. Synchronous: reads the last TRUSTED census `admit()` itself already took, never makes a fresh call. */
  snapshot(): AdmissionSnapshot;
  /**
   * BUTCHR-297 (§B4): clear the accumulated wait for candidates whose spawn
   * ACTUALLY SUCCEEDED this poll — see this file's own top-comment B4
   * addendum for why admission and running are different events, and why
   * this must NEVER be called with an id merely because it was admitted.
   * `reconcileNow` (src/daemon/loop.ts) is the only intended caller: it
   * already computes exactly the right set (`admitted` minus the ids in
   * `failures` with `stage: "spawn"`) via its own optional success hook. An
   * id with no ledger entry (never withheld, or already cleared) is a
   * harmless no-op. Synchronous, like `snapshot()` — no census plumbing.
   */
  recordSpawned(succeeded: readonly string[]): void;
}

/** Pure: which of `candidates` (already in the desired admit order) fit inside `budget` slots. Exported for direct unit testing of the arithmetic at/below/above the cap, independent of any census plumbing. */
export function admitWithinBudget(candidates: readonly string[], budget: number): { admitted: readonly string[]; withheld: readonly string[] } {
  const b = Math.max(0, budget);
  return { admitted: candidates.slice(0, b), withheld: candidates.slice(b) };
}

/**
 * BUTCHR-297: pure reordering of `candidates` by accumulated wait —
 * DESCENDING, tie-broken by the existing lexicographic key ASCENDING so
 * equal waits (cold start, an unsaturated fleet, every wait still 0)
 * reproduce today's exact order byte-for-byte. `waits` is read-only here;
 * incrementing/clearing it is `createAdmissionController`'s job below — this
 * function has no census plumbing and is exported for direct unit testing,
 * exactly as `admitWithinBudget` already is. A candidate absent from
 * `waits` is treated as wait 0, same as one that has never been withheld.
 */
export function orderByWait(candidates: readonly string[], waits: ReadonlyMap<string, number>): readonly string[] {
  return [...candidates].sort((a, b) => {
    const wa = waits.get(a) ?? 0;
    const wb = waits.get(b) ?? 0;
    if (wa !== wb) return wb - wa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * BUTCHR-320 (B/D): the self-describing admission line, built once here so
 * `admit()`'s one call site and any test constructing an expected sample
 * (see the discontinuity test) share the exact same formatting — never two
 * independent string templates that could drift. Fires unconditionally
 * whenever the caller reaches it (i.e. `candidates.length > 0` — the
 * `candidates.length === 0` short-circuit in `admit()` never calls this at
 * all, and that silence is documented at that call site, not here). Carries
 * `admittedCount` even when it's 0 (a fully-saturated poll) and the withheld
 * id list only when there's something withheld — `withheld 0/N` with no
 * trailing `wanted:` clause is exactly as parseable as the withheld-nonzero
 * case, just shorter.
 */
export function admissionLine(cap: number, residency: number, admittedCount: number, totalCandidates: number, withheld: readonly string[], waits: ReadonlyMap<string, number>): string {
  const base = `${ADMISSION2_TAG} cap=${cap} residency=${residency} admitted=${admittedCount} withheld ${withheld.length}/${totalCandidates}`;
  if (withheld.length === 0) return base;
  const withheldDesc = withheld.map((id) => `${id}(${waits.get(id) ?? 0})`).join(", ");
  return `${base} wanted: ${withheldDesc}`;
}

/** Which of `admit()`'s two early-return fail-safe paths produced an `admissionFailSafeLine` — see that function's own doc comment. */
export type AdmissionFailSafe = "census-threw" | "implausible-zero";

/**
 * BUTCHR-334 (finding 1): the SAME tag as `admissionLine` (never a
 * second/silent format), for `admit()`'s two fail-safe early returns —
 * `residency()` throwing, and a readable-but-still-untrusted implausible
 * zero (see this file's own top-comment Trap 2). BEFORE this ticket, both
 * paths withheld every candidate but returned before `admissionLine` was
 * ever called, so "a missing `[admission2]` line means this poll had zero
 * spawn candidates" was FALSE on either path whenever `candidates.length >
 * 0` — the WARNING line was the only trace, and only in the journal, never
 * mechanically distinguishable from an absent poll. This line closes that:
 * every poll `admit()` reaches with at least one candidate now logs exactly
 * one `[admission2]`-tagged line, whichever of the three paths (ordinary,
 * census-threw, implausible-zero) it took — so "no `[admission2]` line" now
 * means, by construction, "zero candidates that poll," full stop. Mirrors
 * `admissionLine`'s own `admitted=`/`withheld N/M` fields exactly (every
 * candidate is withheld on a fail-safe path, so `admittedCount` is always 0
 * and the ratio is always `N/N`) but OMITS `residency=`, deliberately: a
 * fail-safe path by definition has no TRUSTED residency figure to report
 * (`census-threw` has no reading at all; `implausible-zero`'s own reading is
 * exactly the untrusted one this path exists to reject — reporting it as if
 * it were `residency=` would misrepresent it as trusted). `fail-safe=<reason>`
 * takes that field's place instead, naming which of the two paths fired — a
 * reader who greps for `residency=` therefore correctly gets zero hits on a
 * fail-safe line, distinguishing it from an ordinary one at a glance, same
 * spirit as `ADMISSION2_TAG`'s own doc comment on why a wholly distinct
 * signal (here, a field, not a tag) beats a caveat the reader has to
 * remember. Only ever called with `candidates.length > 0` (the empty-
 * candidates case logs nothing on ANY path, ordinary or fail-safe alike —
 * the existing, unchanged short-circuit in `admit()`).
 */
export function admissionFailSafeLine(cap: number, reason: AdmissionFailSafe, candidates: readonly string[]): string {
  return `${ADMISSION2_TAG} cap=${cap} admitted=0 withheld ${candidates.length}/${candidates.length} fail-safe=${reason} wanted: ${candidates.join(", ")}`;
}

/** Builds the shared, fleet-wide admission controller wired into BOTH `runResourceLoop` call sites (src/daemon/index.ts) via `ReconcileOptions.admission` (src/daemon/loop.ts). */
export function createAdmissionController(deps: AdmissionControllerDeps): AdmissionController {
  const log = (line: string) => deps.log?.(line);
  const guard = new ImplausibleZeroGuard(deps.maxImplausiblePolls);
  /** Last TRUSTED residency — null means no trusted observation yet (cold start: the very next zero is trusted, not treated as implausible). */
  let lastTrusted: number | null = null;
  /** BUTCHR-297: accumulated wait per candidate, in `admit()` calls — see this file's own top-comment addendum (B1/B2/B4) for why calls, and why this is only ever touched by the code that received a given id as an argument this call. */
  const waits = new Map<string, number>();
  /** BUTCHR-297 (§B2): the call number each ledger entry was last touched at — the eviction bookkeeping `LEDGER_UNSEEN_EVICTION_CALLS` is measured against. Only ever holds keys that are also in `waits`. */
  const lastSeenCall = new Map<string, number>();
  /** BUTCHR-297: advances once per `admit()` call that actually reaches the ordering/ledger block below — never on the empty-candidates or fail-safe early returns (see B3), consistent with those paths leaving the ledger untouched entirely. */
  let callCount = 0;
  /** BUTCHR-297: the withheld set from the last TRUSTED, non-empty `admit()` call — `/health`'s `longestWait` (see AdmissionSnapshot) reads its FIRST element, which is already the longest-waiting (or equal-longest, lexicographically-first) candidate, since `withheld` is itself a suffix of `orderByWait`'s fully-sorted order. */
  let lastWithheld: readonly string[] = [];

  async function admit(candidates: readonly string[], stopping: readonly string[]): Promise<readonly string[]> {
    let resident: readonly string[];
    try {
      resident = await deps.residency();
    } catch (e) {
      // Failure shape (1) — see this module's own top comment. Unambiguous:
      // withhold everything, touch nothing about the trust state (a herdr
      // outage is a different condition from a readable-but-wrong answer).
      if (candidates.length) {
        log(`WARNING: [admission] residency census threw (${(e as Error)?.message ?? e}) — withholding all ${candidates.length} wanted this poll (fail-safe): ${candidates.join(", ")}`);
        log(admissionFailSafeLine(deps.cap, "census-threw", candidates));
      }
      return [];
    }
    const observed = resident.length;

    // Failure shape (2) — see this module's own top comment, Trap 2(b)/(c).
    // A cold start (lastTrusted === null) is never implausible: there is no
    // prior trusted observation for a bare zero to contradict.
    const implausible = lastTrusted !== null && lastTrusted > 0 && observed === 0 && stopping.length < lastTrusted;

    if (implausible) {
      const stillUntrusted = guard.record();
      if (stillUntrusted) {
        if (candidates.length) {
          log(`WARNING: [admission] residency read 0 but was last trusted at ${lastTrusted} and this poll's own plan only stops ${stopping.length} of that — treating as an untrustworthy read (BUTCHR-282-shaped), not a real drop (streak ${guard.currentStreak}/${deps.maxImplausiblePolls ?? MAX_IMPLAUSIBLE_POLLS}); withholding all ${candidates.length} wanted this poll`);
          log(admissionFailSafeLine(deps.cap, "implausible-zero", candidates));
        }
        return [];
      }
      // Trap 2(d): the bound is exceeded — accept the zero as real rather
      // than deadlock a genuinely-emptied fleet forever. Bounded mitigation
      // only, NOT a fix for BUTCHR-282 (Trap 2(e)) — falls through to the
      // ordinary trusted path below, exactly as if this read had been
      // plausible from the start.
      log(`WARNING: [admission] residency has read 0 for more than ${deps.maxImplausiblePolls ?? MAX_IMPLAUSIBLE_POLLS} consecutive polls despite a last-trusted value of ${lastTrusted} — bound exceeded, accepting the zero as real (bounded mitigation, not a fix for BUTCHR-282 — see src/agents/admission.ts)`);
    } else {
      guard.clear();
    }

    lastTrusted = observed;
    // Review fix (round 1): an empty candidate list means nothing is
    // withheld, full stop — `lastWithheld` must say so too, or a candidate
    // that leaves `desired` WITHOUT ever being admitted (ticket closed,
    // moved out of an active status, mid-withholding) leaves `/health`
    // reporting it as the longest-waiting one forever, since nothing else
    // ever recomputes `lastWithheld` once its own candidate list goes
    // empty. This does NOT touch the wait ledger (`waits`/`lastSeenCall`/
    // `callCount` are untouched below, same as before) and does not
    // violate B3 — B3 is about the ledger, and both fail-safe paths return
    // earlier than this line already.
    if (candidates.length === 0) { lastWithheld = []; return candidates; }
    callCount++;
    // BUTCHR-297: order BEFORE slicing — see this file's own top-comment
    // addendum for why aging lives here and why the tie-break reproduces
    // today's exact order at wait 0.
    const ordered = orderByWait(candidates, waits);
    const budget = deps.cap - observed;
    const { admitted, withheld } = admitWithinBudget(ordered, budget);
    // §A4/B1/B4: increment the wait for every candidate withheld THIS call
    // only — never an admitted one (admission is not the same event as
    // running; recordSpawned below is the only thing that ever clears an
    // entry) and never a key absent from `candidates` altogether (a key
    // from the OTHER tier's disjoint set is never iterated here at all, so
    // there is no branch that could touch it). `lastSeenCall` is refreshed
    // for every withheld id (just wrote it) and for every admitted id that
    // still carries a LEFTOVER wait from a prior withholding (limbo between
    // admission and a confirmed spawn, B4) — an id with no ledger entry at
    // all (never withheld) is never added to either map here.
    for (const id of withheld) {
      waits.set(id, (waits.get(id) ?? 0) + 1);
      lastSeenCall.set(id, callCount);
    }
    for (const id of admitted) {
      if (waits.has(id)) lastSeenCall.set(id, callCount);
    }
    // §B2: evict-after-unseen, never "clear what's absent this call" (B1's
    // bug). Sweeping the whole ledger each call is cheap — its size is
    // bounded by the fleet's own distinct-candidate count.
    for (const [id, seenAt] of lastSeenCall) {
      if (callCount - seenAt > LEDGER_UNSEEN_EVICTION_CALLS) {
        waits.delete(id);
        lastSeenCall.delete(id);
      }
    }
    lastWithheld = withheld;
    // BUTCHR-320 (B/D): fires on EVERY poll that reaches this point — i.e.
    // every poll with at least one candidate, including `withheld = 0` —
    // unlike the old `[admission]` line this replaces, which only ever fired
    // behind `withheld.length > 0` (confirmed at this commit: any admissions
    // total summed from the old line was a floor, never a count, biased low
    // by exactly the polls where spawning proceeded freely). Carries the
    // ADMITTED count too, not only withheld — see `ADMISSION2_TAG`'s own doc
    // comment for why the tag itself changed (criterion D) rather than
    // reusing `[admission]` with a wider firing condition.
    log(admissionLine(deps.cap, observed, admitted.length, candidates.length, withheld, waits));
    return admitted;
  }

  function recordSpawned(succeeded: readonly string[]): void {
    for (const id of succeeded) {
      waits.delete(id);
      lastSeenCall.delete(id);
    }
  }

  return {
    admit,
    recordSpawned,
    snapshot: () => {
      const longestId = lastWithheld[0];
      const longestWait = longestId !== undefined ? { id: longestId, polls: waits.get(longestId) ?? 0 } : null;
      return { cap: deps.cap, residency: lastTrusted, longestWait };
    },
  };
}
