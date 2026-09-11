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
 * SAFE BY CONSTRUCTION, NOT BY CARE — BUT ONLY WITH `invalidateActive` ALSO
 * WIRED IN, SEE BELOW: `check` below only ever inspects ids the CALLER
 * (`reconcileNow`) already independently determined are `atRest` THIS POLL,
 * from a FRESH `discovery.search()` + `verdictFor` read (`atRestFrom`,
 * src/daemon/loop.ts) — i.e. ids the rest of the system has already decided
 * mean "eligible AND every watermark caught up" (BUTCHR-66/83's `"asleep"`),
 * independent of anything this module tracks. That establishes `check` is
 * safe for THIS poll's read of `"asleep"` — it does NOT, by itself,
 * establish that a declaration `check` consumes still describes the agent
 * currently running for that id: consumption can be deferred to a poll long
 * after the one that declared. Closing that gap is `invalidateActive`'s
 * entire job (see "PER-EPISODE INVALIDATION" below) — without it wired in,
 * this module can still, in a real if narrow path, cause a genuinely-pending
 * resource to be stopped, which code review caught. With both `check` and
 * `invalidateActive` wired (as `src/daemon/index.ts` does), the worst this
 * module can do is let an ALREADY-asleep resource, whose declaration has not
 * gone stale, skip the frozen-timeout grace period — which is the point.
 *
 * NOT TIME-BOUNDED, DELIBERATELY: unlike `FrozenAsleepTracker`, this holds no
 * elapsed-time floor and no restart-adoption logic — there is nothing to
 * adopt across a restart (a lost in-memory declaration just means that one
 * project waits out the ordinary frozen-asleep bound instead of exiting
 * promptly, exactly as it did before this ticket) and nothing that needs a
 * clock. `declare` is a plain one-shot flag, `check` consumes (deletes) it
 * the moment it is used to unprotect an id. Memory cost is one string per
 * distinct project id ever declared and not yet consumed — bounded by the
 * number of live, eligible projects, never unbounded.
 *
 * PER-EPISODE INVALIDATION (added in code review — the first version of
 * this module got this wrong): a declaration that is never consumed on the
 * very next poll (the project goes active again before that poll observes
 * it resting) used to simply WAIT, on the theory that this was harmless —
 * it is not. `check`'s consumption is deferred to whichever LATER poll
 * happens to see the id resting-and-running, and there is no guarantee that
 * is a continuation of the SAME episode that declared: a project's verdict
 * can return to `"asleep"` with NO fresh `check_in` at all
 * (`src/resources/project.ts`'s `projectVerdict`: `epicsBehind` is computed
 * over epics CURRENTLY in review, so an epic simply LEAVING review takes
 * that axis from behind to caught-up with no watermark write). Down that
 * path, a declaration from a FINISHED episode — the agent that made it
 * crashed, was session-limited, or was respawned as stale — would be
 * consumed against a DIFFERENT, later agent instance for the same project,
 * silently stopping it mid-work. That is exactly what `atRest` exists to
 * prevent (see its own doc comment on the advance-watermark-then-exit
 * race), and a declaration is not exempt from that requirement just because
 * it is optimistic rather than a timeout.
 *
 * `invalidateActive(desired)` closes this: called on EVERY poll (never
 * gated by `atRest`/`restingRunning`, unlike `check` — see
 * `ReconcileOptions.invalidateDeclaredDone`'s own doc comment for why it
 * cannot share that gate), it drops any declared-but-unconsumed id the
 * instant that SAME id is observed ACTIVE (present in `desired`) again.
 * Once a project goes active, whatever made it eligible before is stale by
 * definition — new work has been observed — so the old declaration cannot
 * be trusted to describe the agent that will eventually check the box next.
 * A project that later returns to `"asleep"` after that point needs its own
 * fresh `declare()`, exactly like any other new episode; until one arrives,
 * ordinary `atRest`/`checkFrozenAsleep` protection applies, same as a
 * project that had never declared at all. This is what makes "a stale
 * declaration from a finished episode can never stop a different, later
 * agent for the same project" actually true, rather than true only in the
 * common case.
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
  /**
   * Wired into `ReconcileOptions.invalidateDeclaredDone` (src/daemon/loop.ts)
   * — called on EVERY poll, unlike `check` above. Drops any declared id
   * found in `desired` (this poll's active-verdict set): see this module's
   * own top comment, "PER-EPISODE INVALIDATION", for the hazard this closes
   * (a declaration surviving an intervening active period and being consumed
   * against a later, different agent instance for the same project id).
   * Synchronous and side-effect-free beyond the in-memory prune — never
   * throws.
   */
  invalidateActive(desired: readonly string[]): void;
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
    invalidateActive(desired: readonly string[]): void {
      for (const id of desired) declared.delete(id);
    },
  };
}
