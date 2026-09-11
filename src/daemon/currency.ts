import type { CurrencyVerdict } from "../agents/build-currency.js";

/**
 * BUTCHR-329: caches a build-currency verdict (`src/agents/build-currency.ts`
 * — reused here, not reimplemented) for `/health`, as a FOURTH sibling
 * alongside `build`/`coverage`/`admission` (see `combineHealth`,
 * src/daemon/health.ts).
 *
 * WHY A CACHE AT ALL: `computeBuildCurrency` shells out to `git` several
 * times and reads `FETCH_HEAD` from the common dir plus every linked
 * worktree's git-dir (measured: 78 linked worktrees on one real clone — see
 * that module's own doc comment). Far too expensive to redo on every
 * `/health` poll — this is an acceptance criterion, not an optimisation.
 *
 * WHY THE AGE IS ITS OWN FIELD, SEPARATE FROM THE VERDICT: a cached verdict
 * is itself a thing that can go stale, and a reader must be able to tell a
 * fresh one from a cached one — the same disease this whole story exists to
 * fix, one level up. `checkedAt` is `null` only before this tracker has
 * EVER computed a verdict; once one has landed, it is always a real ISO
 * timestamp, even on a run whose `verdict` itself is `unknown`.
 *
 * WHY RECOMPUTE IS LAZY (ON ACCESS), NOT A BACKGROUND TIMER:
 * `computeBuildCurrency` already can't hang — every `git` call inside it is
 * time-bounded (`GIT_TIMEOUT_MS`, src/agents/build-currency.ts) and the
 * function has its own outer catch, the same guarantee the agent-spawn path
 * (src/agents/workspace.ts) already relies on to call it unconditionally on
 * every spawn. A periodic background timer (the `createLoopHealth` pattern)
 * would keep paying that git cost even while nobody is polling `/health` at
 * all; a lazy recompute gated on `intervalMs` pays it only when a poll
 * actually lands after the interval has elapsed, at most once per interval —
 * which is the acceptance criterion, with no extra timer plumbing. So
 * `snapshot()` is synchronous, like `CoverageTracker.snapshot` and
 * `AdmissionController.snapshot`, and it cannot hang for a reason it does
 * not already have: it inherits `computeBuildCurrency`'s own bound rather
 * than inventing a second one.
 *
 * COLD CACHE (a request lands before this tracker has ever computed
 * anything): that first `snapshot()` call computes inline — safe, because
 * that computation is exactly as bounded as every other one this tracker
 * ever performs, so it cannot hang `/health` any more than a later one can.
 * If `compute` itself somehow fails unexpectedly (a hard backstop; the
 * injected `computeBuildCurrency` already promises never to throw), the
 * result still degrades to `unknown` with a reason — never a plausible
 * default, the same house rule `build-currency.ts` states for itself.
 */
export interface CurrencyReport {
  /** ISO timestamp of when `verdict` was computed — `null` only before this tracker's first computation has completed. A reader must be able to tell a fresh verdict from a cached one; this is that signal. */
  checkedAt: string | null;
  verdict: CurrencyVerdict;
}

export interface CurrencyTracker {
  /** Cached snapshot for `/health` — recomputes at most once per `intervalMs`, synchronous, never throws. */
  snapshot(): CurrencyReport;
}

/**
 * Matches `PROJECT_POLL_INTERVAL_MS` (src/resources/project.ts) — this
 * codebase's existing precedent for a periodic check with a comparable cost
 * profile (also several git-adjacent/network calls, also deliberately not
 * run per-request). Not imported directly: that constant belongs to the
 * project poll loop's own cadence decision, and the two are free to diverge
 * later without this tracker's default silently moving with it.
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const COLD_REASON = "this daemon has not yet computed a build-currency verdict";

export function createCurrencyTracker(deps: { compute: () => CurrencyVerdict; intervalMs?: number; now?: () => number }): CurrencyTracker {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let cached: CurrencyReport = { checkedAt: null, verdict: { status: "unknown", reason: COLD_REASON } };
  let lastCheckedMs: number | null = null;

  return {
    snapshot() {
      const nowMs = now();
      if (lastCheckedMs === null || nowMs - lastCheckedMs >= intervalMs) {
        lastCheckedMs = nowMs;
        let verdict: CurrencyVerdict;
        try {
          verdict = deps.compute();
        } catch (e) {
          // `computeBuildCurrency` already never throws — this is a hard
          // backstop, matching that module's own discipline: never let this
          // tracker's own bookkeeping become the thing that hangs or throws
          // `/health`.
          verdict = { status: "unknown", reason: `currency refresh failed unexpectedly: ${(e as Error).message}` };
        }
        cached = { checkedAt: new Date(nowMs).toISOString(), verdict };
      }
      return cached;
    },
  };
}
