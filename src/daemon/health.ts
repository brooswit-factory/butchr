import type { BuildReport } from "../agents/build-identity.js";
import type { DetectorCoverage } from "./coverage.js";
import type { AdmissionSnapshot } from "../agents/admission.js";
import type { CurrencyReport } from "./currency.js";

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
  /**
   * BUTCHR-54: this daemon's own running build identity (sha/version/start/
   * pid/unit) — deliberately a SIBLING field, never an entry in
   * `components[]`. `ok` is the AND over components on purpose (liveness);
   * a daemon that doesn't know its own sha is not thereby unhealthy, so
   * build identity must never be able to flip `ok`. Absent entirely when
   * the caller (see src/daemon/index.ts) doesn't pass one to
   * `combineHealth` — e.g. every existing test fixture in this file's test
   * suite, unaffected by this addition.
   */
  build?: BuildReport;
  /**
   * BUTCHR-179: per-detector verification coverage — a SECOND sibling,
   * alongside `build`, for the same reason `build` is one: `ok` is the AND
   * over liveness `components[]` on purpose, and a detector declining to
   * verify one ticket this poll (an Atlassian fetch that failed) does not
   * mean the DAEMON is unhealthy — the poll loop itself completed fine.
   * Conflating the two would make an external, transient, already-logged
   * Atlassian degradation flip `ok` red, which an uptime checker would read
   * as "restart the daemon" — actively unhelpful, since a restart fixes
   * nothing about Atlassian. Absent entirely when the caller doesn't pass
   * one to `combineHealth` (see `src/daemon/coverage.ts`'s `CoverageTracker`
   * and its call sites for what populates this in production).
   */
  coverage?: DetectorCoverage[];
  /**
   * BUTCHR-284: the admission cap and current fleet-wide residency — a THIRD
   * sibling, alongside `build`/`coverage`, for the same reason those two
   * are: `ok` is the AND over liveness `components[]` on purpose, and
   * sitting AT the cap is a normal, healthy state — it must never be able
   * to flip `ok` red (see src/agents/admission.ts for the full mechanism).
   * `residency` is `null` before this daemon has taken any TRUSTED census
   * yet (see `AdmissionController.snapshot`) — never a bare `0`, which would
   * be indistinguishable from "checked, genuinely empty". Absent entirely
   * when the caller doesn't pass one to `combineHealth` (e.g. every existing
   * test fixture in this file's own test suite, unaffected by this
   * addition).
   */
  admission?: AdmissionSnapshot;
  /**
   * BUTCHR-329: this daemon's own build-currency verdict (whether its
   * running build matches `refs/remotes/origin/main` — see
   * src/agents/build-currency.ts) — a FOURTH sibling, alongside
   * `build`/`coverage`/`admission`, for the same reason those three are:
   * `ok` is the AND over liveness `components[]` on purpose, and a daemon
   * running STALE code is not thereby *unhealthy* in the liveness sense —
   * it is stale, which is a different claim, and conflating the two is the
   * whole disease this field exists to name honestly instead of hiding.
   * `/health` already has a 503 contract other things key on; flipping `ok`
   * for staleness would change the meaning of an endpoint other things
   * depend on, and whether `/health` may ever go red for a non-liveness
   * reason is a separate, still-open question (BUTCHR-276) this field
   * deliberately does not touch.
   *
   * `verdict.status` is `"current" | "stale" | "unknown"`, always present
   * and always carrying its own evidence (an `unknown` verdict always
   * carries a `reason` — required by `CurrencyVerdict`'s own type, so it
   * can never be silently empty) — a consumer parsing JSON can distinguish
   * "nothing is wrong" from "I could not check" by `verdict.status` alone,
   * never merely by a human reading prose (BUTCHR-175's founding rule).
   *
   * Expensive to compute (see src/daemon/currency.ts's own doc comment), so
   * this is a CACHED value, recomputed at most once per interval — read
   * `checkedAt` alongside `verdict`: a cached verdict is itself a thing
   * that can go stale, and a reader must be able to tell a fresh one from a
   * cached one, the same disease this whole field exists to fix, one level
   * up. Absent entirely when the caller doesn't pass one to `combineHealth`
   * (e.g. every existing test fixture in this file's own test suite,
   * unaffected by this addition) — never a bare missing field once the
   * daemon IS passing one, which would be indistinguishable from an older
   * daemon that never had the feature.
   */
  currency?: CurrencyReport;
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

/**
 * Combine several independently-tracked `LoopHealth` components into one
 * `/health` response (BUTCHR-57): `ok` is the AND of every component, and
 * `components` is their concatenation, in the order given. Deliberately
 * additive rather than a change to `createLoopHealth`/`status()` themselves —
 * a single `createLoopHealth` instance keeps its existing one-component
 * contract untouched (BUTCHR-18/BUTCHR-6's callers, and any test built on
 * that shape, are unaffected); a caller with more than one liveness signal to
 * report (the poll loop, the notify stage) calls each instance's `status()`
 * and combines the results here instead. `build` (BUTCHR-54), `coverage`
 * (BUTCHR-179), and `admission` (BUTCHR-284) all ride along as sibling
 * fields on the returned `HealthStatus` — see each type's own doc comment
 * for why none of them is ever folded into `components[]`.
 */
export const combineHealth = (
  components: readonly LoopHealth[],
  build?: BuildReport,
  coverage?: readonly DetectorCoverage[],
  admission?: AdmissionSnapshot,
  currency?: CurrencyReport,
): HealthStatus => {
  const statuses = components.map((c) => c.status());
  return {
    ok: statuses.every((s) => s.ok),
    components: statuses.flatMap((s) => s.components),
    ...(build ? { build } : {}),
    ...(coverage ? { coverage: [...coverage] } : {}),
    ...(admission ? { admission } : {}),
    ...(currency ? { currency } : {}),
  };
};

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
