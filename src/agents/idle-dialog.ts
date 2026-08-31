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

/** The persistent bottom-of-terminal frame every real pane-cap-*.txt capture in this repo ends in, dialog or not: a horizontal rule, the idle composer prompt with nothing typed, and the mode/hint status line. */
const CHROME_RULE = /^─+$/;
const CHROME_COMPOSER = /^❯$/;
const CHROME_STATUS = /^⏵⏵/;

/**
 * True only when EVERYTHING after the LAST footer-shaped line in `text`, to
 * the end of the pane, is that persistent terminal chrome — never AGENT
 * PROSE (a bullet-prefixed narration line, a tool-result `⎿` continuation, an
 * ordinary sentence).
 *
 * WHY THIS EXISTS (PR #104 review, blocking): `parsePrompt`'s existing gates
 * (footer immediately after the last option, exactly one cursor) verify the
 * dialog BLOCK itself, but say nothing about what follows it. herdr's
 * `blocked` classification used to be the thing that made that safe — a
 * pane herdr calls blocked is, by construction, showing that dialog as its
 * live composer state right now. Once this module lets an IDLE pane reach
 * the same parser, that guarantee is gone: an agent that `cat`s a
 * dialog-shaped fixture, narrates about it, and then goes idle produces a
 * pane whose SCROLLBACK carries a perfectly well-formed dialog (real
 * cursor, real footer) with the agent's own prose after it, followed by the
 * pane's OWN genuinely-live composer chrome at the very end. Verified
 * against a live repro on 82c4a2b: such a pane parsed, `chooseStartupAnswer`
 * recognized it, and `keysToSelect` produced a real Down+Enter that would
 * have been sent into a working agent's composer.
 *
 * KNOWN RESIDUAL GAP, stated rather than hidden: an agent that `cat`s such a
 * fixture and goes idle with ZERO narration between the tool result and its
 * own live chrome would still pass this check (the footer is then followed
 * by nothing but real chrome). Closing that fully would mean recognizing
 * that the dialog block itself sits inside a tool-result rendering (e.g. by
 * its indentation), which needs ground truth this repo does not have for a
 * live dialog (no real capture combines a real footer with real trailing
 * chrome — see prompt.test.ts's provenance notes on pane-cap-a/b). This
 * check closes the demonstrated repro and everything that ends in visible
 * narration; the zero-narration variant is a smaller, harder-to-verify
 * residual left for a follow-up with a real fixture to test against, not
 * guessed at silently.
 */
export function endsInLiveChrome(text: string): boolean {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_LINE.test(lines[i]!)) { footerIdx = i; break; }
  }
  if (footerIdx === -1) return false; // no footer at all — not this check's concern; parsePrompt already rejects it
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (CHROME_RULE.test(t) || CHROME_COMPOSER.test(t) || CHROME_STATUS.test(t)) continue;
    return false;
  }
  return true;
}

/**
 * The full "is this pane text a LIVE dialog at the end of the pane" check
 * this module's caller needs: `parsePrompt`'s own gates, AND (idle-path
 * only — see `endsInLiveChrome`) nothing but terminal chrome after it.
 */
export function parsesAsLiveDialog(text: string): boolean {
  return parsePrompt(text) !== null && endsInLiveChrome(text);
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
 * `minutes` — whose pane text parses as a real, LIVE dialog AT THE END OF
 * THE PANE (`parsePrompt`'s own KAN-756 anti-false-positive gates, PLUS
 * `endsInLiveChrome`'s idle-path-only check that nothing but terminal
 * chrome follows it — see that function's doc for why the second check is
 * required here and not in `parsePrompt` itself) is reported back with
 * `agent_status` overridden to `"blocked"`.
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
    // Prune panes that dropped out of this poll's rows (the herd shrank, or
    // a pane was recreated under a new id) — without this the tracker only
    // ever grows across a daemon's lifetime. A later reappearance under the
    // same id starts a fresh floor, same as any other forget().
    const present = new Set(rows.map((r) => r.pane_id));
    for (const paneId of tracker.trackedPaneIds()) if (!present.has(paneId)) tracker.forget(paneId);

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
      out.push(parsesAsLiveDialog(text) ? { ...row, agent_status: "blocked" } : row);
    }
    return out;
  };
}
