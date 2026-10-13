import { createStalledCheck } from "./stalled.js";
import { mapAgentStatus } from "../labels/plan.js";
import type { StallObservation } from "./stalled-events.js";

/** Project/managed-session inactivity uses the same status/comment detector
 * as tickets. Missing, working, blocked and frozen agents never qualify. */
export function createResourceStallObserver(deps: {
  now?: () => number;
  statuses: () => Promise<ReadonlyMap<string, string>>;
  comments: (id: string) => Promise<readonly { id: string; body: string; created: string }[]>;
}) {
  const minutesById = new Map<string, number>();
  const revisions = new Map<string, number>();
  const detector = createStalledCheck({ now: deps.now ?? Date.now, minutes: 10,
    minutesFor: (id) => minutesById.get(id), comments: deps.comments });
  const observe = async (id: string, minutes: number, enabled = true, revision?: number): Promise<StallObservation> => {
    minutesById.set(id, minutes);
    if (revision !== undefined && revisions.get(id) !== revision) {
      detector.forget(id);
      revisions.set(id, revision);
    }
    const status = enabled ? mapAgentStatus((await deps.statuses()).get(id) ?? null) : "none";
    const stalled = await detector.check(id, status);
    return { key: id, minutes, stalled: stalled === true };
  };
  return Object.assign(observe, { forget: (id: string) => { detector.forget(id); minutesById.delete(id); revisions.delete(id); } });
}
