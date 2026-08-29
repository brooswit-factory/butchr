/** A recognised Claude Code session-limit refusal, parsed from ANSI-stripped pane text. */
export interface SessionLimitRefusal {
  /**
   * Next epoch ms at/after `now` when the printed reset clock time occurs, or
   * null if the refusal was recognised but no reset time could be parsed —
   * conservative by construction: never invented, only reported absent so an
   * operator can see recovery cannot be scheduled.
   */
  resetsAt: number | null;
  /** The matched refusal line, verbatim, for logging. */
  raw: string;
}

/**
 * How many of the pane's trailing CONTENT lines (blank/decorative lines
 * skipped and not counted) can contain a genuine, currently-rendered
 * refusal. NOT "the last content line" — a real idle Claude Code pane still
 * renders its composer (a bare `❯` box, "? for shortcuts", the
 * "⏵⏵ bypass permissions on …" status line) BELOW the refusal, so requiring
 * the refusal to be strictly last would never match the exact pane this
 * feature exists to recover (caught at review, PR #68: the committed
 * fixtures happened to test "does this file end right after the refusal",
 * not "is the refusal recent enough" — verified against fixtures with
 * realistic trailing chrome that N=3 and N=4 both separate every case
 * cleanly, with the quoted-scrollback cases still ≥5 content lines away).
 * This is deliberately the same discipline as src/agents/prompt.ts's
 * QUESTION_TAIL/footerImmediatelyFollows (KAN-756/761): position relative to
 * the END of the pane is the signal, not the phrase's presence, because this
 * exact phrase sits verbatim in KAN-804 and KAN-807's own ticket text and so
 * will be in scrollback (a rendered ticket/comment body, an agent's own
 * narration) whenever an agent reads either ticket — an unbounded match
 * would close a perfectly healthy pane.
 */
const TAIL_LINES = 4;

/** Pane chrome that carries no content — box borders/rules — transparent when looking for "what's last". */
const DECORATIVE = /^[─│╭╮╰╯·\s]*$/;

/**
 * Anchored to the START of the (trimmed) line, never a phrase embedded in a
 * longer sentence, a quoted block, a diff line, a `⎿` tool-result line, or a
 * comment body — the same anchoring prompt.ts's FOOTER uses, for the same
 * reason (KAN-756 comment 14956): the position IS the signal.
 */
const REFUSAL_LINE = /^You(?:'|’)ve hit your session limit\b.*$/;
const RESET_TIME = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i;

/**
 * Recognise the "You've hit your session limit" refusal in ANSI-stripped pane
 * text and, if present, resolve the printed reset clock time to the next
 * occurrence at or after `now` (treated as LOCAL time — a 9:50pm reset seen
 * at 6:59pm is tonight; seen at 11pm it is tomorrow). `now` is injected: this
 * module does no I/O and never reaches for the clock itself.
 *
 * Returns null unless the refusal is among the pane's last `TAIL_LINES`
 * CONTENT lines (chrome-only lines skipped and not counted) AND is itself
 * the whole line once trimmed — never merely present somewhere in the text.
 * The caller (see session-limit-watch.ts / herd.ts) additionally requires
 * the agent's `agent_status` to be idle/done before treating this as live;
 * that conjunct is NOT enforced here since this module has no status.
 */
export function detectSessionLimitRefusal(text: string, now: Date): SessionLimitRefusal | null {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  // Collect the last TAIL_LINES content lines, walking up from the end and
  // skipping blank/decorative (content-free) lines for free — they carry no
  // signal either way, so they don't count against the budget.
  const content: string[] = [];
  for (let i = lines.length - 1; i >= 0 && content.length < TAIL_LINES; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || DECORATIVE.test(trimmed)) continue;
    content.push(trimmed);
  }
  for (const line of content) {
    const m = REFUSAL_LINE.exec(line);
    if (!m) continue;
    const rt = RESET_TIME.exec(line);
    if (!rt) return { resetsAt: null, raw: line };
    return { resetsAt: resolveResetTime(rt, now), raw: line };
  }
  return null;
}

function resolveResetTime(m: RegExpExecArray, now: Date): number | null {
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() < now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}
