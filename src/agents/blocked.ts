export interface AgentStatusRow { pane_id: string; agent_status: string }

/** Panes currently blocked. Pure. */
export const blockedNow = (rows: readonly AgentStatusRow[]): string[] =>
  rows.filter((a) => a.agent_status === "blocked").map((a) => a.pane_id).sort();

export type Stop = () => void;

/**
 * Poll agent statuses; call `onBlocked(paneId)` for EVERY pane that is blocked,
 * EVERY poll — not just on the transition into blocked. One-shot-on-transition
 * was the KAN-682 failure: if the dialog wasn't parseable at that instant (or
 * one read failed), nothing ever retried while the agent stayed blocked. While
 * a pane stays blocked the handler keeps getting the chance to act; handlers
 * are re-parsed-and-idempotent by design. This also answers CHAINS of startup
 * dialogs, where only the first raises a transition. Returns a stop.
 */
export function watchBlocked(
  list: () => Promise<AgentStatusRow[]>,
  intervalMs: number,
  onBlocked: (paneId: string) => void,
  onError?: (e: unknown) => void,
): Stop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      for (const pane of blockedNow(await list())) { if (stopped) return; onBlocked(pane); }
    } catch (e) {
      onError?.(e);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
