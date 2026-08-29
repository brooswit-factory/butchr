import { detectSessionLimitRefusal } from "./session-limit.js";

export interface AgentRow { pane_id: string; agent_status: string; issue: string | null }

export interface SessionLimitWatchDeps {
  /** Every currently running butchr agent, with its herdr status and resolved issue key (null for a foreign pane). */
  list: () => Promise<AgentRow[]>;
  /** Read the detection region of a pane, ANSI stripped — same shape as prompt-watch's `read`. */
  read: (paneId: string) => Promise<string>;
  /** Close the issue's agent pane; the existing reconciler respawns it with a fresh kickoff within one poll. */
  close: (issue: string) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export type Stop = () => void;

/**
 * Grace period after the printed reset time before closing the pane, not
 * zero: absorbs clock skew between the daemon's host clock and whatever
 * clock Claude printed the reset time from, plus the observation that the
 * limit isn't necessarily lifted the exact instant it prints (measured the
 * night of the incident: the agent was confirmed working ~40s after the
 * pane was closed, comfortably inside this margin).
 */
export const POST_RESET_MARGIN_MS = 2 * 60_000;

/**
 * Level-triggered, not scheduled (KAN-804/807): every poll, for every agent
 * whose status is idle/done — the cheap gate, so a working or blocked agent's
 * pane is never read here — check for a session-limit refusal and, once past
 * its printed reset time plus POST_RESET_MARGIN_MS, close the pane so the
 * existing reconciler respawns the agent with a fresh kickoff. Nothing is
 * persisted: a daemon restarted at any point re-reads the same pane text and
 * reaches the same decision, which is what makes an hours-away reset
 * survivable across restarts. Before the reset, this only logs — once per
 * distinct (issue, resetsAt) pair, not every poll (the escalator's
 * dedupe-by-distinct-fingerprint in escalation-loop.ts is the local
 * precedent).
 */
export function watchSessionLimits(deps: SessionLimitWatchDeps, intervalMs: number): Stop {
  // issue -> the resetsAt FIRST resolved for this refusal, and whether it's
  // been logged. Pinned deliberately: detectSessionLimitRefusal always
  // resolves to the NEXT occurrence at-or-after the `now` it's given, so
  // re-resolving fresh on every poll against an ever-advancing `now` would
  // never let `now` catch up to it — the instant real time passes today's
  // target, a fresh resolve rolls to TOMORROW's, forever staying just out of
  // reach. Pinning to the first resolution (closest to when the refusal
  // actually appeared) is what makes "close after resetsAt+margin" reachable
  // at all. Lost on a daemon restart like everything else here — a restart
  // before the reset re-derives the same future target from the pane alone;
  // a restart in the brief margin window after the reset but before this
  // poller has closed the pane is the one case that re-derives a stale
  // "tomorrow" instead and waits a full day — rare, and self-correcting.
  const seen = new Map<string, { resetsAt: number; logged: boolean }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      const rows = await deps.list();
      for (const row of rows) {
        if (stopped) return;
        if (row.agent_status !== "idle" && row.agent_status !== "done") continue;
        if (!row.issue) continue;
        const text = await deps.read(row.pane_id);
        const refusal = detectSessionLimitRefusal(text, new Date(deps.now()));
        if (!refusal) { seen.delete(row.issue); continue; }
        if (refusal.resetsAt === null) {
          // Conservative: never invent a reset time. An operator-visible line
          // beats silently never recovering — this pane needs a human.
          deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} refused ("${refusal.raw}") but no reset time could be parsed — cannot schedule recovery, needs an operator`);
          continue;
        }
        const entry = seen.get(row.issue) ?? { resetsAt: refusal.resetsAt, logged: false };
        seen.set(row.issue, entry);
        if (!entry.logged) {
          entry.logged = true;
          deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} refused ("${refusal.raw}"), resets ${new Date(entry.resetsAt).toISOString()} — will close the pane ${POST_RESET_MARGIN_MS / 60_000}m after reset so the reconciler respawns with a fresh kickoff`);
        }
        if (deps.now() >= entry.resetsAt + POST_RESET_MARGIN_MS) {
          await deps.close(row.issue);
          seen.delete(row.issue);
        }
      }
    } catch (e) {
      deps.log(`[session-limit] poll failed: ${(e as Error)?.message ?? e}`);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
