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

/**
 * `atRest` (BUTCHR-66/83): resource ids currently `"asleep"` per
 * `Activation<T>.verdictFor` — excluded from `desired` (so `spawn`/`respawn`
 * already never include them, automatically, since both are computed as
 * intersections/differences against `desired`), but that alone is NOT enough
 * for `stop`: `stop = running − desired` would otherwise catch an asleep
 * resource that IS running and shut it off. THE RACE THIS GUARDS: a woken
 * agent's last two acts are advance-watermark then exit; between those two
 * acts the resource reads `asleep` while its agent is STILL RUNNING. A poll
 * landing in that window must never stop it — so `stop` also subtracts
 * `atRest`, independent of `desired`. Defaults to empty so every existing
 * caller (none of which has ever had an asleep-capable resource type) is
 * unaffected.
 */
export function planReconcile(desired: Iterable<string>, running: Iterable<string>, stale: Iterable<string> = [], atRest: Iterable<string> = []): ReconcilePlan {
  const want = new Set(desired);
  const have = new Set(running);
  const badArgv = new Set(stale);
  const resting = new Set(atRest);
  return {
    spawn: [...want].filter((k) => !have.has(k)).sort(),
    stop: [...have].filter((k) => !want.has(k) && !resting.has(k)).sort(),
    respawn: [...badArgv].filter((k) => want.has(k) && have.has(k)).sort(),
  };
}

/** The statuses that warrant a running agent. */
export const ACTIVE_STATUSES = new Set(["In Progress", "In Review"]);
export const isActive = (status: string): boolean => ACTIVE_STATUSES.has(status);
