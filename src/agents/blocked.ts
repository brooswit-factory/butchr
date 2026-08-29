export interface AgentStatusRow { pane_id: string; agent_status: string }

/** Panes currently blocked. Pure. */
export const blockedNow = (rows: readonly AgentStatusRow[]): string[] =>
  rows.filter((a) => a.agent_status === "blocked").map((a) => a.pane_id).sort();

export type Stop = () => void;

/**
 * Poll agent statuses; call `onBlocked(paneId, pollSeq)` for EVERY pane that
 * is blocked, EVERY poll — not just on the transition into blocked.
 * One-shot-on-transition was the KAN-682 failure: if the dialog wasn't
 * parseable at that instant (or one read failed), nothing ever retried while
 * the agent stayed blocked. While a pane stays blocked the handler keeps
 * getting the chance to act; handlers are re-parsed-and-idempotent by
 * design. This also answers CHAINS of startup dialogs, where only the first
 * raises a transition. Returns a stop.
 *
 * `pollSeq` is a per-tick counter, starting at 1, strictly increasing —
 * every call within one tick (the `onTick` call and every `onBlocked` call
 * for that tick's blocked panes) carries the SAME value. A caller that
 * tracks per-pane state (KAN-756: the escalation debounce) can use it to
 * tell "still blocked, same poll window" from "blocked again after a gap",
 * and to safely discard a stale result that resolves out of order relative
 * to a later tick's.
 *
 * `onTick`, if given, fires synchronously at the START of each tick — before
 * any `onBlocked` call for that tick — with the full blocked-pane set. A
 * caller can use it to reset state for any pane it is tracking that is NOT
 * in that set: a poll on which a previously-blocked pane simply isn't
 * blocked anymore is a real signal (KAN-756: it must reset the debounce),
 * and nothing else in this module can deliver it, since `onBlocked` is only
 * ever called for panes that ARE blocked.
 */
export function watchBlocked(
  list: () => Promise<AgentStatusRow[]>,
  intervalMs: number,
  onBlocked: (paneId: string, pollSeq: number) => void,
  onError?: (e: unknown) => void,
  onTick?: (blockedPaneIds: readonly string[], pollSeq: number) => void,
): Stop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollSeq = 0;
  const tick = async (): Promise<void> => {
    try {
      const ids = blockedNow(await list());
      pollSeq++;
      onTick?.(ids, pollSeq);
      for (const pane of ids) { if (stopped) return; onBlocked(pane, pollSeq); }
    } catch (e) {
      onError?.(e);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
