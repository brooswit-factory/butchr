import type { ComponentHealth, LoopWatchdogReport } from "./health.js";

/**
 * FACTORY-772 (follow-up to FACTORY-722/#682): the backstop for any
 * never-settling await that `BUTCHR_HERDR_TIMEOUT_MS` (every shared herdr
 * client call) and the permission-answer watchdog's own deadline do NOT
 * cover — specifically the issue loop's `pollLoop`/`notify` liveness
 * components (src/daemon/health.ts's `createLoopHealth`, wired in
 * src/daemon/index.ts). #682 bounds the calls THIS daemon makes; it cannot
 * bound an await this daemon is merely waiting on with no timeout of its
 * own (e.g. a hung promise inside a detector, or a future dependency that
 * adds an unbounded wait of its own) — if one of those ever stalls the poll
 * or notify stage for longer than `thresholdMs`, this is what notices and
 * forces a fresh loop into its place, rather than leaving the daemon stuck
 * forever with `/health` quietly red.
 *
 * DELIBERATELY NOT the same shape as `startPermissionAnswerWatch`'s own
 * watchdog (src/agents/permission-answer-watch.ts): that one shares a
 * single mutable `inFlight` flag between its sweep ticks and its watchdog
 * trip, and forcibly clears it to unstick the NEXT tick — which is exactly
 * the shape FACTORY-746 is fixing bugs in (re-tripping every 30s on an
 * already-stale entry; a forced reset with no generation guard letting a
 * late-settling tick's own `.finally()` clear state out from under a newer
 * one). This module never reuses or force-clears anything belonging to the
 * loop it restarts: a trip calls `target.restart()`, which (in production,
 * see src/daemon/index.ts) discards the wedged `watch()` loop's `Stop`
 * handle outright and starts a completely independent one in its place —
 * there is no shared in-flight flag for an old, wedged loop instance to
 * race against a new one over, because the two never share any mutable
 * state at all. The generation/epoch guard below still exists, scoped to
 * THIS module's own bookkeeping (`restarting`/`restartCount`/
 * `lastRestartAt`), for the same reason every other "never let a stale
 * async completion clobber newer state" guard in this codebase exists: a
 * belated `restart()` settlement must never undo a NEWER restart's own
 * accounting, even though (by the `restarting` guard immediately below)
 * two restarts for the same target can never actually run concurrently in
 * the first place.
 */
export interface LoopWatchdogTarget {
  /**
   * The `ComponentHealth.name`(s) this target's restart covers, as reported
   * in `/health`'s `loopWatchdog` sibling array. More than one name is for
   * the case `pollLoop`/`notify` are — two independent liveness heartbeats
   * for the SAME underlying `watch()` loop (src/daemon/loop.ts): one
   * `restart()` call fixes both, so both names must show the SAME restart
   * in `/health`, not just whichever one happened to cross the threshold
   * first on a given check.
   */
  names: readonly string[];
  /**
   * This target's current liveness component(s) — called fresh on every
   * watchdog check (never cached), so a target whose underlying loop was
   * just replaced by a PRIOR restart sees that replacement's real, current
   * state rather than a snapshot taken at construction time.
   */
  components: () => readonly ComponentHealth[];
  /**
   * Force a fresh loop into this target's place. May be async; the
   * watchdog will not consider this target eligible to trip again until
   * this settles AND `thresholdMs` has passed since the restart it just
   * performed (see `createLoopWatchdog`'s own doc comment for why the
   * latter, not merely "this settled", is the real re-trip guard).
   */
  restart: () => void | Promise<void>;
}

export interface LoopWatchdogOptions {
  /**
   * How long a target may stay `"stale"` (see `ComponentHealth.state`)
   * before this watchdog forces a restart. Bounds-checked at the config
   * layer (src/config/config.ts's `loopWatchdogThresholdMs`) — deliberately
   * NOT re-validated here, since every production caller already goes
   * through that parse and a direct test caller is exercising THIS module,
   * not the config guard.
   */
  thresholdMs: number;
  /** How often this watchdog checks every target. Default 10s — comfortably below any sane `thresholdMs` (config-enforced minimum 30s), so a trip is noticed promptly without checking so often it costs anything measurable. */
  checkIntervalMs?: number;
  now?: () => number;
  /** Free-text daemon log line for each trip. Optional; omitted, a trip is still recorded (restartCount/lastRestartAt) but nothing is logged. */
  log?: (line: string) => void;
}

export interface LoopWatchdog {
  /** Current restart history for every target, flattened to one entry per name — see `LoopWatchdogReport`. */
  reports(): LoopWatchdogReport[];
  /** Stops the check timer. Idempotent. Does not, and cannot, affect a `restart()` already in flight. */
  stop(): void;
}

interface TargetState {
  restartCount: number;
  lastRestartAt: number | null;
  /** True from the instant a trip calls `restart()` until that call settles — the guard that makes two concurrent restarts of the SAME target impossible (see this module's own top comment for why no further generation/epoch logic is needed to prevent that case, only to prevent a belated settlement from clobbering a newer one's bookkeeping). */
  restarting: boolean;
  /** Bumped on every trip; a `restart()` promise's own `.finally()` only clears `restarting` when its generation is still current. */
  generation: number;
}

/**
 * Checks every target on a timer and forces a restart the first time it is
 * found `"stale"` for at least `thresholdMs`. See this module's own top
 * comment for the full design and why it is deliberately NOT shaped like
 * `startPermissionAnswerWatch`'s watchdog.
 */
export function createLoopWatchdog(targets: readonly LoopWatchdogTarget[], opts: LoopWatchdogOptions): LoopWatchdog {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const state: TargetState[] = targets.map(() => ({ restartCount: 0, lastRestartAt: null, restarting: false, generation: 0 }));

  const checkOne = (i: number): void => {
    const target = targets[i]!;
    const s = state[i]!;
    // A restart is already in flight for this target — never start a
    // second one concurrently, and never re-evaluate staleness until it
    // settles (its own completion below re-arms eligibility, subject to
    // the cooldown immediately after).
    if (s.restarting) return;
    const nowMs = now();
    // FACTORY-772 AC4 / sibling defect (a): re-measure staleness from the
    // RESTART, not the loop's own (unchanged, still-old) lastSuccessAt.
    // `ComponentHealth.staleForMs` keeps growing from that old timestamp
    // until the fresh loop this restart started actually ticks — without
    // this cooldown, every check in that window would see "still stale,
    // past threshold" and trip AGAIN, exactly the "stale entries re-
    // tripping every 30s" bug FACTORY-746 is fixing in the sibling
    // permission-answer watchdog. Guarding on OUR OWN restart clock, not
    // the component's heartbeat, is what makes this a re-measurement
    // rather than a repeat read of the same stale fact.
    if (s.lastRestartAt !== null && nowMs - s.lastRestartAt < opts.thresholdMs) return;
    const components = target.components();
    const staleMs = Math.max(0, ...components.filter((c) => c.state === "stale").map((c) => c.staleForMs));
    if (staleMs < opts.thresholdMs) return;

    const gen = ++s.generation;
    s.restarting = true;
    s.restartCount++;
    s.lastRestartAt = nowMs;
    log(`  [watchdog] ${target.names.join("/")} STALE for ${Math.round(staleMs / 1000)}s (threshold ${Math.round(opts.thresholdMs / 1000)}s) — restarting`);
    void Promise.resolve()
      .then(() => target.restart())
      .catch((e) => {
        log(`  [watchdog] ${target.names.join("/")} restart failed: ${(e as Error)?.message ?? e}`);
      })
      .finally(() => {
        // A belated settlement from a SUPERSEDED trip (gen !== s.generation)
        // must never clear `restarting` out from under a newer trip's own
        // bookkeeping — the exact "late-settling tick's .finally() clears
        // in-flight state under the new tick" hazard FACTORY-746 is fixing
        // in the sibling watchdog. Structurally this can only happen if
        // `restarting` were ever cleared by anything other than this exact
        // `.finally()` (it is not), so this is belt-and-suspenders over the
        // guard above, not a condition reachable today — kept anyway
        // because the cost of checking is one integer comparison and the
        // cost of ever getting it wrong is two restarts racing each other.
        if (gen !== s.generation) return;
        s.restarting = false;
      });
  };

  const timer = setInterval(() => {
    for (let i = 0; i < targets.length; i++) checkOne(i);
  }, opts.checkIntervalMs ?? 10_000);
  timer.unref?.();

  return {
    reports: () =>
      targets.flatMap((target, i) => {
        const s = state[i]!;
        return target.names.map((name) => ({
          name,
          restartCount: s.restartCount,
          lastRestartAt: s.lastRestartAt === null ? null : new Date(s.lastRestartAt).toISOString(),
        }));
      }),
    stop: () => clearInterval(timer),
  };
}
