/**
 * The controller diff: given the issues that SHOULD have an agent (In Progress
 * or In Review), the issues that currently DO, and (optionally) which of those
 * running issues are STALE (running, but their process argv lacks butchr's
 * spawn flags — see src/agents/argv.ts), decide what to start, stop, and
 * respawn. Pure.
 *
 * "stop" is the half that shuts off agents whose ticket left the active states.
 * "respawn" is the half that replaces a stale agent with a fresh one — a key
 * here never also appears in "spawn" or "stop": staleness only applies to an
 * agent that is both desired AND already running.
 */
export interface ReconcilePlan {
  spawn: string[];   // desired but not running
  stop: string[];    // running but no longer desired
  respawn: string[]; // desired AND running, but stale
}

export function planReconcile(desired: Iterable<string>, running: Iterable<string>, stale: Iterable<string> = []): ReconcilePlan {
  const want = new Set(desired);
  const have = new Set(running);
  const badArgv = new Set(stale);
  return {
    spawn: [...want].filter((k) => !have.has(k)).sort(),
    stop: [...have].filter((k) => !want.has(k)).sort(),
    respawn: [...badArgv].filter((k) => want.has(k) && have.has(k)).sort(),
  };
}

/** The statuses that warrant a running agent. */
export const ACTIVE_STATUSES = new Set(["In Progress", "In Review"]);
export const isActive = (status: string): boolean => ACTIVE_STATUSES.has(status);
