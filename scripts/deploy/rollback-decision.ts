/**
 * BUTCHR-465: the pure decision at the heart of the Codey deploy watchdog
 * (`scripts/deploy/watchdog.ts`) — given a health snapshot (or the absence
 * of one) and the watchdog's own armed state, decide whether the deploy
 * looks healthy, needs a rollback, or there is nothing to do. Kept separate
 * from `watchdog.ts` so the decision can be tested with fixtures instead of
 * a real daemon, a real `git`, and a real `systemctl` — mirroring this
 * repo's `scripts/release/gate.ts` / `scripts/release/facts.ts` split.
 *
 * GOVERNING RULE: an unreachable or malformed `/health` response is treated
 * exactly like an unhealthy one — "the daemon didn't answer" is the
 * textbook case this watchdog exists for (a restart that never came back
 * up), never a reason to assume health and walk away.
 */

/** The subset of `/health` (src/daemon/health.ts) this decision reads. Anything else on the real response is ignored. */
export interface HealthSnapshot {
  ok: boolean;
  build?: { sha: string | null };
}

export interface RollbackDecisionInput {
  /** The sha the deploy was supposed to land on (the new build). */
  expectedSha: string;
  /** The live `/health` response, or `null` if it could not be fetched/parsed at all (timeout, connection refused, non-2xx, invalid JSON). */
  health: HealthSnapshot | null;
  /** True once a prior check (or an explicit `disarm`) already resolved this watchdog run — a fired timer must never act twice. */
  disarmed: boolean;
}

export type RollbackAction = "noop" | "healthy" | "rollback";

export interface RollbackDecision {
  action: RollbackAction;
  reason: string;
}

export function decideRollback(input: RollbackDecisionInput): RollbackDecision {
  if (input.disarmed) {
    return { action: "noop", reason: "watchdog already disarmed — nothing to do" };
  }
  if (input.health === null) {
    return { action: "rollback", reason: "/health could not be reached at all (timeout, connection refused, or invalid response) — treated as unhealthy" };
  }
  if (!input.health.ok) {
    return { action: "rollback", reason: "/health reported ok=false" };
  }
  const runningSha = input.health.build?.sha ?? null;
  if (runningSha !== input.expectedSha) {
    return {
      action: "rollback",
      reason: `running build sha ${runningSha === null ? "unknown" : runningSha} does not match the deployed sha ${input.expectedSha} — the daemon may have come back up on the wrong checkout state`,
    };
  }
  return { action: "healthy", reason: `/health is ok and running the expected build ${input.expectedSha}` };
}
