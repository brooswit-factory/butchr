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

  /** Pane ids currently tracked — used to prune ones that dropped out of a poll's rows, so this never grows unbounded across a daemon's lifetime. */
  trackedPaneIds(): string[] {
    return [...this.since.keys()];
  }
}

/**
 * A footer-shaped line, anchored to line start like prompt.ts's own FOOTER —
 * duplicated rather than imported so this stays a self-contained, purely
 * additive check that never touches `parsePrompt`'s behavior for its
 * original caller (a pane herdr ALREADY calls blocked has earned the
 * benefit of the doubt; a pane that merely looks idle has not — PR #104
 * review).
 */
const FOOTER_LINE = /^\s*Enter to (confirm|select)/;

/**
 * The bottom-of-terminal frame every WORKING-pane capture in this repo
 * (`pane-cap-a.txt`, `pane-cap-b.txt` — the KAN-756 false-positive
 * captures, taken while NO dialog was showing) ends in: a horizontal rule,
 * the idle composer prompt with nothing typed, the mode/hint status line.
 * This is NOT derived from a real dialog's trailing region — this repo has
 * no real capture combining a genuine footer with genuine trailing chrome
 * (`grep -l "Enter to (confirm|select)" test/fixtures/*.txt` on this
 * ticket's base branch matches nothing) — it is a generalisation from
 * working panes to blocked ones, stated plainly rather than implied (PR
 * #104 second review). Treat this as one recognized-safe shape among
 * several possible ones, never as the exhaustive definition of "live" — see
 * `classifyTrailing`.
 */
const CHROME_RULE = /^─+$/;
const CHROME_COMPOSER = /^❯$/;
const CHROME_STATUS = /^⏵⏵/;

/**
 * The demonstrated signature of a STALE dialog quoted in scrollback (PR #104
 * first review's repro, reproduced against 82c4a2b): a Claude Code turn
 * bullet (`●`/`■`, used for narration and tool-invocation lines, never part
 * of a live dialog's own rendering) or a tool-result continuation prefix
 * (`⎿`) appearing after the footer. Either is conclusive: both are markers
 * Claude Code's OWN TUI puts around a PRIOR turn's transcript, and neither
 * can appear inside a live blocking dialog's own render.
 */
const STALE_BULLET = /^[●■]/;
const STALE_TOOL_CONTINUATION = /⎿/;

export type TrailingClassification = "live" | "stale" | "unknown";

/**
 * Classify what follows the LAST footer-shaped line in `text`, to the end of
 * the pane, into three outcomes — replacing a binary "is this live" check
 * that failed toward SILENCE (PR #104 second review): any trailing shape
 * this repo has no fixture for (a boxed dialog's `╰────╯` closing border, a
 * footer split across two lines, a non-bypass status line, a scroll hint —
 * ALL real possibilities the ticket itself named as unknown) was being
 * dropped outright, which is exactly DoD 1's failure mode for a REAL dialog.
 *
 * - `"live"`: nothing after the footer, or only the recognized chrome
 *   (`CHROME_RULE`/`CHROME_COMPOSER`/`CHROME_STATUS`). Auto-answer if
 *   `chooseStartupAnswer` recognizes it, escalate otherwise — unchanged
 *   from before this classification existed.
 * - `"stale"`: the demonstrated scrollback-quote signature
 *   (`STALE_BULLET`/`STALE_TOOL_CONTINUATION`) appears anywhere after the
 *   footer. Dropped entirely — not blocked at all. This is what closes the
 *   first review's repro.
 * - `"unknown"`: anything else. The two hazards here are asymmetric BY
 *   OUTCOME, not by detection: auto-answering a stale quote sends a real
 *   keystroke into a working composer (expensive); escalating one costs one
 *   already-deduped, already-rate-capped Jira comment (cheap). So `unknown`
 *   is treated as blocked — read, and escalated — but the caller MUST NEVER
 *   auto-answer it (see `withIdleDialogDetection`'s `isUnknownTrailing`):
 *   we cannot verify the dialog is live, but the ticket's own stated
 *   asymmetry (one notification vs. hours × agent count) says escalate
 *   anyway rather than sit silent. The escalation's captured pane text is
 *   exactly the mechanism for promoting a real recurring shape to `"live"`
 *   with actual ground truth, instead of guessing at the allowlist.
 */
export function classifyTrailing(text: string): TrailingClassification {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_LINE.test(lines[i]!)) { footerIdx = i; break; }
  }
  // Defensive only: every caller only reaches this after parsePrompt already
  // found a footer, so this branch is not expected to be exercised.
  if (footerIdx === -1) return "unknown";

  const trailing = lines.slice(footerIdx + 1).map((l) => l.trim()).filter(Boolean);
  if (trailing.some((t) => STALE_BULLET.test(t) || STALE_TOOL_CONTINUATION.test(t))) return "stale";
  const allChrome = trailing.every((t) => CHROME_RULE.test(t) || CHROME_COMPOSER.test(t) || CHROME_STATUS.test(t));
  return allChrome ? "live" : "unknown";
}

export interface IdleDialogDetectorDeps {
  now: () => number;
  /** N minutes: see IdleDialogTracker. */
  minutes: number;
  /** Read the detection region of a pane, ANSI stripped — same shape as prompt-watch's `read`. */
  read: (paneId: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface IdleDialogDetector {
  /** The wrapped status-row lister — pass this to `watchBlocked` exactly where the raw lister used to go. */
  list: () => Promise<AgentStatusRow[]>;
  /**
   * True if `paneId` is CURRENTLY flagged blocked via an `"unknown"`
   * trailing region (see `classifyTrailing`) — i.e. we could not verify the
   * dialog is live, only that it isn't a recognized stale quote either. The
   * caller (`daemon/index.ts`'s `onPrompt`) MUST return `undefined` for such
   * a pane regardless of what `chooseStartupAnswer` would say, forcing
   * escalation instead of a keystroke sent on unverifiable evidence. Always
   * false for a pane herdr classifies `"blocked"` natively — that path never
   * runs this module's classification at all, so herdr's own classification
   * keeps the full benefit of the doubt it already had.
   */
  isUnknownTrailing: (paneId: string) => boolean;
}

/**
 * Wraps a status-row lister (herdr's own `agent.list()`, in production) so
 * that any pane herdr classifies idle/done — continuously, for at least
 * `minutes` — whose pane text parses as a dialog (`parsePrompt`'s own
 * KAN-756 anti-false-positive gates) AND whose trailing region classifies as
 * `"live"` or `"unknown"` (never `"stale"` — see `classifyTrailing`) is
 * reported back with `agent_status` overridden to `"blocked"`.
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
 * escalation path — `isUnknownTrailing` is the one extra bit the caller
 * needs to keep that pipeline from auto-answering on unverifiable evidence.
 *
 * COST GATE (not optional — see the ticket): pane text is read only for a
 * row that ALREADY satisfies the cheap, synchronous `IdleDialogTracker`
 * precondition. A pane that is working, or one that's idle/done but hasn't
 * cleared the bound yet, costs zero extra I/O.
 */
export function withIdleDialogDetection(
  list: () => Promise<AgentStatusRow[]>,
  deps: IdleDialogDetectorDeps,
): IdleDialogDetector {
  const tracker = new IdleDialogTracker(deps.now, deps.minutes);
  const unknownTrailing = new Set<string>();

  return {
    list: async () => {
      const rows = await list();
      // Prune panes that dropped out of this poll's rows (the herd shrank,
      // or a pane was recreated under a new id) — without this the tracker
      // (and the unknownTrailing flag) only ever grow across a daemon's
      // lifetime. A later reappearance under the same id starts fresh.
      const present = new Set(rows.map((r) => r.pane_id));
      for (const paneId of tracker.trackedPaneIds()) {
        if (!present.has(paneId)) { tracker.forget(paneId); unknownTrailing.delete(paneId); }
      }

      const out: AgentStatusRow[] = [];
      for (const row of rows) {
        if (!tracker.observe(row.pane_id, row.agent_status)) {
          unknownTrailing.delete(row.pane_id); // left idle/done, or hasn't cleared the bound — not a candidate
          out.push(row);
          continue;
        }
        let text: string;
        try {
          text = await deps.read(row.pane_id);
        } catch (e) {
          deps.log?.(`[idle-dialog] ${row.pane_id} pane read failed: ${(e as Error)?.message ?? e}`);
          out.push(row);
          continue;
        }
        if (parsePrompt(text) === null) { unknownTrailing.delete(row.pane_id); out.push(row); continue; }
        const kind = classifyTrailing(text);
        if (kind === "stale") { unknownTrailing.delete(row.pane_id); out.push(row); continue; }
        if (kind === "unknown") unknownTrailing.add(row.pane_id);
        else unknownTrailing.delete(row.pane_id);
        out.push({ ...row, agent_status: "blocked" });
      }
      return out;
    },
    isUnknownTrailing: (paneId) => unknownTrailing.has(paneId),
  };
}
