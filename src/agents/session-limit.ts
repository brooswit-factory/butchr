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
 * How many of the pane's trailing lines (after dropping blank lines and pane
 * chrome that carries no content — box-drawing borders, rules) can contain a
 * genuine, currently-rendered refusal. A live refusal is the last thing
 * Claude Code renders: the CLI has stopped accepting input, so nothing real
 * follows it — only a border/blank line might. This is deliberately the same
 * discipline as src/agents/prompt.ts's QUESTION_TAIL/footerImmediatelyFollows
 * (KAN-756/761): position relative to the END of the pane is the signal, not
 * the phrase's presence, because this exact phrase sits verbatim in KAN-804
 * and KAN-807's own ticket text and so will be in scrollback (a rendered
 * ticket/comment body, an agent's own narration) whenever an agent reads
 * either ticket — an unanchored match would close a perfectly healthy pane.
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
 * content lines (chrome-only lines skipped, real content never is) AND is
 * itself the whole line once trimmed — never merely present somewhere in the
 * text. The caller (see session-limit-watch.ts / herd.ts) additionally
 * requires the agent's `agent_status` to be idle/done before treating this as
 * live; that conjunct is NOT enforced here since this module has no status.
 */
export function detectSessionLimitRefusal(text: string, now: Date): SessionLimitRefusal | null {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  // Walk up from the end, skipping only blank/decorative (content-free) lines
  // — up to TAIL_LINES of them — to find the last line that carries content.
  // A real dialog's own scrollback (prose, tool output, the composer status
  // bar) is never content-free, so this never walks past a genuine boundary.
  let i = lines.length - 1;
  let skipped = 0;
  while (i >= 0 && skipped < TAIL_LINES) {
    const trimmed = lines[i]!.trim();
    if (trimmed && !DECORATIVE.test(trimmed)) break;
    i--; skipped++;
  }
  if (i < 0) return null;
  const trimmed = lines[i]!.trim();
  const m = REFUSAL_LINE.exec(trimmed);
  if (!m) return null; // the last real content line is something else — not a live refusal
  const rt = RESET_TIME.exec(trimmed);
  if (!rt) return { resetsAt: null, raw: trimmed };
  return { resetsAt: resolveResetTime(rt, now), raw: trimmed };
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
