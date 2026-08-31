import { parsePrompt } from "./prompt.js";
import type { AgentStatusRow } from "./blocked.js";

/**
 * Tracks, per pane, how long its herdr status has been continuously
 * idle/done. In-memory only — lost on a daemon restart, which is fine
 * (mirrors StalledTracker in stalled.ts): `observe()` just starts a fresh
 * floor from that restart's first poll, which only ever DELAYS the signal
 * (a real dialog sits a little longer before we notice), never fabricates
 * one.
 *
 * Unlike StalledTracker's `streakBroken` latch (permanent once the streak
 * breaks), this tracker's floor simply resets whenever the pane leaves
 * idle/done — a pane can go idle, work, then sit on a dialog again, and each
 * idle spell must be timed from ITS OWN start. There is no "has ever worked"
 * concept here; only "how long has it been idle/done RIGHT NOW".
 */
export class IdleDialogTracker {
  private readonly since = new Map<string, number>();
  constructor(
    private readonly now: () => number,
    /** Minutes a pane's status must read idle/done, continuously, before its text is even worth reading. */
    private readonly minutes: number,
  ) {}

  /**
   * Record this poll's status for `paneId` and report whether the cheap
   * precondition holds: continuously idle/done for at least `minutes`. Pane
   * text is NOT read here — the caller only reads it once this returns true
   * (the cost guard: a 5s status poll must never become a pane read per
   * agent per tick).
   */
  observe(paneId: string, status: string): boolean {
    if (status !== "idle" && status !== "done") { this.since.delete(paneId); return false; }
    let start = this.since.get(paneId);
    if (start === undefined) { start = this.now(); this.since.set(paneId, start); }
    return this.now() - start >= this.minutes * 60_000;
  }

  /** Drop tracking for a pane that's gone — a later reappearance starts a fresh floor. */
  forget(paneId: string): void {
    this.since.delete(paneId);
  }
}

export interface IdleDialogDetectorDeps {
  now: () => number;
  /** N minutes: see IdleDialogTracker. */
  minutes: number;
  /** Read the detection region of a pane, ANSI stripped — same shape as prompt-watch's `read`. */
  read: (paneId: string) => Promise<string>;
  log?: (line: string) => void;
}

/**
 * Wraps a status-row lister (herdr's own `agent.list()`, in production) so
 * that any pane herdr classifies idle/done — continuously, for at least
 * `minutes` — whose pane text parses as a real dialog AT THE END OF THE PANE
 * (`parsePrompt`, with its own KAN-756 anti-false-positive gates: footer
 * immediately after the last option, exactly one cursor, a bounded
 * `question` tail) is reported back with `agent_status` overridden to
 * `"blocked"`.
 *
 * This is BUTCHR-5/16's second, herdr-independent blocked-detector: herdr
 * reported all five frozen panes idle/done for the entire ~12 hours they sat
 * on the effort-recommendation dialog, so `blockedNow` (blocked.ts) never
 * saw them and the whole escalation stack never ran. `blockedNow` itself
 * stays pure and untouched — a row this wrapper overrides to `"blocked"`
 * flows through `blockedNow`'s existing `agent_status === "blocked"` filter
 * exactly like a pane herdr itself calls blocked, which is what lets the
 * SAME `watchBlocked`/`watchPrompts`/escalator pipeline (auto-answer,
 * dedup, rate-cap, fingerprint debounce) handle both without a second
 * escalation path.
 *
 * COST GATE (not optional — see the ticket): pane text is read only for a
 * row that ALREADY satisfies the cheap, synchronous `IdleDialogTracker`
 * precondition. A pane that is working, or one that's idle/done but hasn't
 * cleared the bound yet, costs zero extra I/O.
 */
export function withIdleDialogDetection(
  list: () => Promise<AgentStatusRow[]>,
  deps: IdleDialogDetectorDeps,
): () => Promise<AgentStatusRow[]> {
  const tracker = new IdleDialogTracker(deps.now, deps.minutes);
  return async () => {
    const rows = await list();
    const out: AgentStatusRow[] = [];
    for (const row of rows) {
      if (!tracker.observe(row.pane_id, row.agent_status)) { out.push(row); continue; }
      let text: string;
      try {
        text = await deps.read(row.pane_id);
      } catch (e) {
        deps.log?.(`[idle-dialog] ${row.pane_id} pane read failed: ${(e as Error)?.message ?? e}`);
        out.push(row);
        continue;
      }
      out.push(parsePrompt(text) ? { ...row, agent_status: "blocked" } : row);
    }
    return out;
  };
}
