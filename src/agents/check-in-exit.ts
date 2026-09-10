/**
 * BUTCHR-275 (implementing BUTCHR-271) — the exit step itself, the one piece
 * demonstration 6 (BUTCHR-119) found missing: a project agent whose verdict
 * reads `"asleep"` stops occupying its pane PROMPTLY after its own
 * `check_in`, instead of sitting there until `checkFrozenAsleep` reaps it
 * roughly `BUTCHR_ATREST_MINUTES` minutes later.
 *
 * WHY NOT A LITERAL SELF-EXIT: `HerdrHerd.stop(issue)` (src/agents/herd.ts)
 * resolves an agent's pane through a map derived from `agent.list()`; once
 * an agent leaves that list on its own, `stop()` on its issue is a silent
 * no-op forever (see src/agents/reap.ts's own top comment) — no error, no
 * log line, and the pane and workspace stay open, unreachable by anything
 * butchr remembers. `src/agents/reap.ts`'s reclamation (BUTCHR-111) is the
 * fix for THAT leak, keyed on the workspace rather than the agent list — but
 * BUTCHR-271 requires re-deriving, not inheriting, whether it is actually in
 * the build a project agent runs against before relying on it (see that
 * ticket, and this ticket's own PR description, for the measurement). So
 * this module does NOT make the agent exit its own session; it gives the
 * DAEMON a positive, one-shot signal to stop the agent FOR it, through the
 * existing, working `herd.stop()` route, while the agent is still in
 * `agent.list()` — the pane is genuinely released either way, but only this
 * route is safe regardless of which build is actually deployed.
 *
 * THE SIGNAL: `check_in` (src/tools/defs.ts) is the project agent's own,
 * positive last-act declaration that it has caught up — already wired to
 * advance the version/comment/epic watermarks via `advanceProjectWatermark`
 * (src/resources/project.ts). `declare(id)` is called from THAT handler,
 * strictly AFTER its watermark write has resolved without throwing — never
 * before, and never speculatively on entry — so a process that dies mid-`check_in`
 * (before the watermark write lands) never declares anything, and the
 * project simply wakes again on the same trigger next poll, exactly as
 * today. This is what makes "check-in lands before teardown" STRUCTURAL
 * rather than a hope: nothing here can ever remove `atRest` protection for
 * an id whose watermark write has not already completed, because `declare`
 * is never called for one.
 *
 * SHAPED LIKE `checkFrozenAsleep`, DELIBERATELY A SEPARATE HOOK: both
 * `check` here and `frozen-asleep.ts`'s `check` answer the exact same
 * question for `reconcileNow` (src/daemon/loop.ts) — "of these ids that are
 * BOTH `atRest` and running, which are no longer protected?" — and both feed
 * the same `atRest`-reduction step (`ReconcileOptions.checkDeclaredDone`).
 * They are NOT merged into one hook: `checkFrozenAsleep`'s own contract is
 * "never on a bare timeout" and requires an audible `[butchr:frozen]`
 * complaint posted first — a real defect report. A project that declared
 * itself done via `check_in` has not frozen and nothing is wrong; folding
 * this signal into that hook would either force a complaint to be posted for
 * a healthy exit (misleading — see this module's own PR description) or
 * silently weaken that hook's "speak first" invariant for every OTHER
 * caller. Keeping them separate means the DoD's "without a `[butchr:frozen]`
 * complaint, since nothing froze" is true by construction, not by care at
 * each call site.
 *
 * SAFE BY CONSTRUCTION, NOT BY CARE: `check` below only ever inspects ids the
 * CALLER (`reconcileNow`) already independently determined are `atRest`
 * THIS POLL, from a FRESH `discovery.search()` + `verdictFor` read
 * (`atRestFrom`, src/daemon/loop.ts) — i.e. ids the rest of the system has
 * already decided mean "eligible AND every watermark caught up" (BUTCHR-66/
 * 83's `"asleep"`), independent of anything this module tracks. This module
 * can therefore never cause a genuinely-pending resource to be stopped: the
 * worst it can do is let an ALREADY-asleep resource skip the frozen-timeout
 * grace period, which is exactly the point.
 *
 * NOT TIME-BOUNDED, DELIBERATELY: unlike `FrozenAsleepTracker`, this holds no
 * elapsed-time floor and no restart-adoption logic — there is nothing to
 * adopt across a restart (a lost in-memory declaration just means that one
 * project waits out the ordinary frozen-asleep bound instead of exiting
 * promptly, exactly as it did before this ticket) and nothing that needs a
 * clock. `declare` is a plain one-shot flag, `check` consumes (deletes) it
 * the moment it is used to unprotect an id, so a LATER, unrelated sleep
 * episode of the same id needs its own fresh `declare()` call and never
 * silently inherits this one — the same "don't reuse a stale latch across
 * episodes" discipline `FrozenAsleepTracker.forgetMissing` exists for, here
 * achieved by consuming on use rather than by pruning every poll (a
 * declaration that is never consumed — e.g. the project goes active again
 * before the next poll observes it resting — simply waits, harmlessly: see
 * this module's own PR description for why that is not the same hazard
 * `forgetMissing` guards against). Memory cost is one string per distinct
 * project id ever declared and not yet consumed — bounded by the number of
 * live, eligible projects, never unbounded.
 */

/** One poll's worth of ids that are BOTH `atRest` and running — the exact shape `ReconcileOptions.checkFrozenAsleep`/`checkDeclaredDone` (src/daemon/loop.ts) already share. */
export interface CheckInExitRegistry {
  /**
   * Record that `id` (a project key) has just completed its own `check_in` —
   * called from that tool's handler (src/tools/defs.ts), strictly AFTER its
   * `advanceProjectWatermark` write has resolved. Idempotent: declaring an
   * id already declared is a no-op.
   */
  declare(id: string): void;
  /**
   * Wired into `ReconcileOptions.checkDeclaredDone` (src/daemon/loop.ts).
   * Returns the subset of `restingRunning` that has declared itself done
   * since its last consumption, and CONSUMES (deletes) each one it returns.
   * Never throws — there is no I/O here to fail.
   */
  check(restingRunning: readonly string[]): Promise<ReadonlySet<string>>;
}

export function createCheckInExitRegistry(): CheckInExitRegistry {
  const declared = new Set<string>();
  return {
    declare(id: string): void {
      declared.add(id);
    },
    async check(restingRunning: readonly string[]): Promise<ReadonlySet<string>> {
      const out = new Set<string>();
      for (const id of restingRunning) {
        if (declared.has(id)) {
          declared.delete(id);
          out.add(id);
        }
      }
      return out;
    },
  };
}
