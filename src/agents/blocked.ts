import { watch, type Stop } from "@brooswit/sundry";

export interface AgentStatusRow { pane_id: string; agent_status: string }

/** Panes that transitioned INTO `blocked` between two agent lists. Pure. */
export function newlyBlocked(prev: readonly AgentStatusRow[], next: readonly AgentStatusRow[]): string[] {
  const was = new Map(prev.map((a) => [a.pane_id, a.agent_status]));
  return next.filter((a) => a.agent_status === "blocked" && was.get(a.pane_id) !== "blocked").map((a) => a.pane_id).sort();
}

/** Poll agent statuses; call `onBlocked(paneId)` when an agent becomes blocked. Returns a stop. */
export function watchBlocked(
  list: () => Promise<AgentStatusRow[]>,
  intervalMs: number,
  onBlocked: (paneId: string) => void,
  onError?: (e: unknown) => void,
): Stop {
  return watch<AgentStatusRow[]>(
    list,
    (next, prev) => { for (const pane of newlyBlocked(prev, next)) onBlocked(pane); },
    intervalMs,
    onError ? { onError } : {},
  );
}
