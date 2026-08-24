/**
 * The controller diff: given the issues that SHOULD have an agent (In Progress
 * or In Review) and the issues that currently DO, decide what to start and what
 * to stop. Pure.
 *
 * "stop" is the half that shuts off agents whose ticket left the active states.
 */
export interface ReconcilePlan {
  spawn: string[]; // desired but not running
  stop: string[];  // running but no longer desired
}

export function planReconcile(desired: Iterable<string>, running: Iterable<string>): ReconcilePlan {
  const want = new Set(desired);
  const have = new Set(running);
  return {
    spawn: [...want].filter((k) => !have.has(k)).sort(),
    stop: [...have].filter((k) => !want.has(k)).sort(),
  };
}

/** The statuses that warrant a running agent. */
export const ACTIVE_STATUSES = new Set(["In Progress", "In Review"]);
export const isActive = (status: string): boolean => ACTIVE_STATUSES.has(status);
