/**
 * Liveness for the poll loop, independent of the loop's own error seam.
 *
 * `startLoop`'s `onError` only fires when a poll's fetch stage REJECTS — it
 * never fires when the loop dies silently (a synchronous throw inside
 * @brooswit/sundry's `watch()` observe step, or a suspended host simply not
 * ticking) (BUTCHR-18/BUTCHR-6). So liveness here is a POSITIVE heartbeat:
 * `recordSuccess()` is called once a poll cycle has actually completed
 * (search + reconcile + related + label sync all returned), and staleness is
 * the absence of a recent one — never derived from `onError`.
 */
export interface ComponentHealth {
  name: string;
  /** Whether this component is currently healthy. */
  ok: boolean;
  /** "starting": no success yet, still inside the startup grace period. "ok": a recent success. "stale": no success within the threshold, past the grace period. */
  state: "starting" | "ok" | "stale";
  /** ISO timestamp of the last successful cycle, or null if it has never succeeded. */
  lastSuccessAt: string | null;
  /** Milliseconds since the last success (or since start, if it has never succeeded). 0 while "ok". */
  staleForMs: number;
}

export interface HealthStatus {
  ok: boolean;
  components: ComponentHealth[];
}

export interface LoopHealthOptions {
  /** Component name reported in the health response and journal lines. */
  name: string;
  /**
   * How long without a successful cycle before this component is stale — also
   * used as the startup grace period, so "just booted" and "actually stuck"
   * share one documented number instead of two knobs to keep in sync.
   */
  thresholdMs: number;
  now?: () => number;
  /** Free-text daemon log line for stale/recovery transitions. Optional; omitted, transitions are simply never logged. */
  log?: (line: string) => void;
  /** How often the transition watcher checks for a loop that has gone quiet without ever calling recordSuccess() or status(). Default 5s. */
  checkIntervalMs?: number;
}

export interface LoopHealth {
  /** Call once a poll cycle completes successfully. */
  recordSuccess(): void;
  /** Current health snapshot. */
  status(): HealthStatus;
  /** Stop the internal transition-watcher timer. */
  stop(): void;
}

const fmtSecs = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * Tracks one component's liveness off a positive heartbeat. A stale loop is
 * loud on its OWN, without anyone curling `/health` — a timer (not just
 * `recordSuccess`) checks and logs transitions, since the entire point is
 * that a dead loop produces no further events to hang a check off of.
 */
export function createLoopHealth(opts: LoopHealthOptions): LoopHealth {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const startedAt = now();
  let lastSuccessAt: number | null = null;
  let loudlyStale = false;

  const isFresh = () => lastSuccessAt !== null && now() - lastSuccessAt <= opts.thresholdMs;
  const isPending = () => lastSuccessAt === null && now() - startedAt <= opts.thresholdMs;
  const staleForMs = () => (lastSuccessAt === null ? now() - startedAt : now() - lastSuccessAt);

  const checkTransition = () => {
    const fresh = isFresh();
    if (fresh && loudlyStale) {
      loudlyStale = false;
      log(`  [health] ${opts.name} recovered — last success ${new Date(lastSuccessAt!).toISOString()}`);
    } else if (!fresh && !isPending() && !loudlyStale) {
      loudlyStale = true;
      log(`  [health] ${opts.name} STALE — no successful poll in ${fmtSecs(staleForMs())} (threshold ${fmtSecs(opts.thresholdMs)})`);
    }
  };

  const timer = setInterval(checkTransition, opts.checkIntervalMs ?? 5_000);
  timer.unref?.();

  return {
    recordSuccess() {
      lastSuccessAt = now();
      checkTransition();
    },
    status() {
      const fresh = isFresh();
      const state: ComponentHealth["state"] = fresh ? "ok" : isPending() ? "starting" : "stale";
      const components: ComponentHealth[] = [{
        name: opts.name,
        ok: fresh,
        state,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        staleForMs: fresh ? 0 : staleForMs(),
      }];
      return { ok: components.every((c) => c.ok), components };
    },
    stop() {
      clearInterval(timer);
    },
  };
}
