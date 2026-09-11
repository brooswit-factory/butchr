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
 */

/** Mirrors `RESPAWN_SUPPRESS_POLLS`'s own reasoning (src/daemon/loop.ts) and this codebase's existing 4x-multiple convention (`pollStaleMs`/`PROJECT_POLL_STALE_MS`, src/daemon/index.ts): long enough to absorb a transient herdr hiccup spanning a few polls of EITHER tier, short enough that a genuinely-draining fleet is not falsely withheld for long. */
export const MAX_IMPLAUSIBLE_POLLS = 4;

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
}

/** Pure: which of `candidates` (already in the desired admit order) fit inside `budget` slots. Exported for direct unit testing of the arithmetic at/below/above the cap, independent of any census plumbing. */
export function admitWithinBudget(candidates: readonly string[], budget: number): { admitted: readonly string[]; withheld: readonly string[] } {
  const b = Math.max(0, budget);
  return { admitted: candidates.slice(0, b), withheld: candidates.slice(b) };
}

/** Builds the shared, fleet-wide admission controller wired into BOTH `runResourceLoop` call sites (src/daemon/index.ts) via `ReconcileOptions.admission` (src/daemon/loop.ts). */
export function createAdmissionController(deps: AdmissionControllerDeps): AdmissionController {
  const log = (line: string) => deps.log?.(line);
  const guard = new ImplausibleZeroGuard(deps.maxImplausiblePolls);
  /** Last TRUSTED residency — null means no trusted observation yet (cold start: the very next zero is trusted, not treated as implausible). */
  let lastTrusted: number | null = null;

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
    if (candidates.length === 0) return candidates;
    const budget = deps.cap - observed;
    const { admitted, withheld } = admitWithinBudget(candidates, budget);
    if (withheld.length > 0) {
      log(`[admission] cap=${deps.cap} residency=${observed} withheld ${withheld.length}/${candidates.length} wanted: ${withheld.join(", ")}`);
    }
    return admitted;
  }

  return {
    admit,
    snapshot: () => ({ cap: deps.cap, residency: lastTrusted }),
  };
}
