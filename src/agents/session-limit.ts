/**
 * KNOWN, BOUNDED RESIDUAL RISK (BUTCHR-259 review, comment 19465) — recorded
 * here rather than left implicit, per AC4's own standard that a mechanism's
 * limits must be legible, not just its successes:
 *
 * A tool result whose OWN output is, byte-for-byte, a genuine banner's
 * `⎿`-prefixed line immediately paired with its real wrap continuation
 * (`/upgrade`/`/usage-credits`), at margin depth 2, with nothing after it
 * that this module's guards recognise as disqualifying, IS indistinguishable
 * from a live refusal — and is currently recognised as one. Concretely: an
 * agent running `grep -A1 "hit your session limit" <a real capture file>`
 * (or `cat`/`Read` on any source that already contains those exact bytes)
 * produces exactly this shape. Verified directly against this
 * implementation, not theorised.
 *
 * Two candidate guards were tried and both FALSIFIED against real data
 * before concluding this can't be closed from pane text alone:
 *   - "reject a ⎿ line preceded by a tool-invocation line" — falsified by a
 *     genuine capture (BUTCHR-115) whose real banner is immediately preceded
 *     by "  Called butchr" with no invocation glyph: a session-limit
 *     failure can occur mid-turn, on what looks like a tool call, not only
 *     on the initial prompt — this would reject real banners too.
 *   - "require the pane's own last line to BE composer chrome" — doesn't
 *     discriminate: a faithfully-built adversarial pane is ALSO idle and
 *     ALSO ends in real composer chrome (the composer is unconditional
 *     idle-pane UI, not evidence either way about what produced the lines
 *     above it).
 *
 * Claude Code's rendering does not distinguish, in the text it prints,
 * between "the model's own turn was replaced with this refusal string" and
 * "a tool's actual output happens to equal this string" — both are an
 * identical `⎿`-headed, paired, chrome-terminated block. No further
 * structural signal is available to split them.
 *
 * Mitigations, not closures:
 *   - The poller's own `agent_status` idle/done gate (session-limit-watch.ts)
 *     still applies: the pane must have actually finished a turn in exactly
 *     this shape, not merely be mid-command.
 *   - Reproducing the exact bytes (real `⎿` + NBSP) requires the SOURCE data
 *     already contain them verbatim — in practice, a real pane capture file
 *     or this repo's own fixtures/docs. The exposure is narrow and largely
 *     confined to agents working this epic, not the general fleet.
 *
 * What would close it: a signal at the SOURCE (herdr's `pane.read`, or
 * Claude Code itself) distinguishing a genuine API-refusal substitution
 * from ordinary tool-result text — e.g. structured output that tags which
 * segments are model-generated versus tool-returned, rather than the
 * flattened ANSI-stripped string this module receives today. Not available
 * currently; not implemented here.
 */

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
 * The full outcome of classifying a pane's text, distinguishing three cases
 * that a bare `null` collapses into one (BUTCHR-259 AC4 — the whole epic
 * exists because a mechanism that did nothing looked identical to one that
 * was working):
 *
 * - `recognised`: a genuine, currently-live refusal — schedule recovery.
 * - `suppressed`: a refusal-SHAPED, `⎿`-prefixed line was found, but a
 *   structural signal says it is quoted/embedded text (a rendered ticket or
 *   comment body, e.g. KAN-804/807) rather than the pane's own live tool
 *   result. `reason` always says which signal fired — a silent suppression
 *   is exactly the defect this ticket exists to close, restated.
 * - `not-recognised`: no refusal-shaped line found at all (including a bare,
 *   non-`⎿` line outside the legacy TAIL_LINES budget — see below).
 */
export type SessionLimitOutcome =
  | { kind: "recognised"; resetsAt: number | null; raw: string }
  | { kind: "suppressed"; raw: string; reason: string }
  | { kind: "not-recognised" };

/**
 * How many of the pane's trailing CONTENT lines (blank/decorative lines
 * skipped and not counted) can contain a genuine, currently-rendered refusal
 * — but ONLY for the legacy bare-line path below (a refusal with no `⎿`
 * prefix at all). This budget is NOT what makes real, `⎿`-prefixed pane
 * detection work — see the BUTCHR-259 measurement on the pairing-based path
 * above it, which does not consult this constant at all.
 *
 * BUTCHR-259 measured every real `⎿`-prefixed banner across a 52-file/97-
 * occurrence corpus of genuine captures and found content-line depth from
 * the end of the pane ranging from 5 to 25, with ZERO at depth <= 4 — so
 * this budget, if it were still the gate for real panes, would recognise
 * NONE of them; BUTCHR-241 already established separately that even a widened
 * fixed budget alone doesn't help, because the anchor rejects a `⎿`-prefixed
 * line regardless of position. Both findings are why this module no longer
 * uses a fixed depth budget to decide whether a `⎿`-prefixed refusal is
 * live: the depth varies too much (composer chrome, a completion-status
 * line, the banner's own wrap, AND — found independently while building
 * this fix — arbitrary bordered notification/monitor boxes that can land
 * between the banner and the pane's tail with unenumerable free text; see
 * BOX_LINE below) for any fixed or vocabulary-bounded window to reliably
 * reach every genuine banner without either missing real ones or, if
 * widened enough to reach depth 25, reopening the exact false-close risk
 * TAIL_LINES was introduced to close.
 *
 * This constant is kept only for the legacy bare-line path: a refusal with
 * NO tool-result prefix at all is not how Claude Code renders a live
 * refusal (every real capture in the corpus above IS `⎿`-prefixed), so that
 * path exists solely so hand-built text (existing tests, and any future
 * caller that hands this module plain text with no pane chrome) keeps
 * working exactly as before — it carries none of the false-close risk the
 * `⎿`-path's pairing guard exists for, so the same discipline (position
 * relative to the end, per src/agents/prompt.ts's QUESTION_TAIL) is still
 * the right, minimal check for it.
 */
const TAIL_LINES = 4;

/** Pane chrome that carries no content — box borders/rules — transparent when looking for "what's last". */
const DECORATIVE = /^[─│╭╮╰╯·\s]*$/;

/**
 * Anchored to the START of the (trimmed, and — for the `⎿`-path — prefix-
 * stripped) line, never a phrase embedded in a longer sentence, a quoted
 * block, or a diff line — the same anchoring prompt.ts's FOOTER uses, for
 * the same reason (KAN-756 comment 14956): the position IS the signal.
 */
const REFUSAL_LINE = /^You(?:'|’)ve hit your session limit\b.*$/;
const RESET_TIME = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i;

/**
 * Claude Code renders a tool result's first line prefixed with U+23BF (`⎿`),
 * a space, then U+00A0 (NBSP) — every real banner in the BUTCHR-259 corpus
 * carries exactly this prefix, at EXACTLY two leading spaces before the `⎿`
 * (`20 20 e2 8e bf 20 c2 a0` — measured 97/97, zero exceptions, at margin
 * depth 2 and no other depth). Deliberately matched against the RAW line,
 * NOT the trimmed one, and anchored to exactly `{2}` leading spaces: a
 * refusal-shaped line quoted as a CONTINUATION of some OTHER, enclosing
 * tool result — a doc or ticket comment explaining this very fix, which by
 * necessity displays the banner and its continuation in order — renders at
 * margin depth >= 5 (Claude Code's own continuation-alignment column), never
 * 2, because only the enclosing result's own first line ever sits at depth
 * 2. `.trim()` alone would erase that difference (BUTCHR-259 review: a
 * pairing check with no margin gate matches a pane merely reading this
 * fix's own documentation of the pairing — the pair necessarily appears
 * together in prose that explains it, so the corpus of text that trips a
 * margin-blind detector grows every time someone documents the fix). The
 * margin check is the fix: it is what actually distinguishes "the pane's
 * own top-level tool result" from "text nested inside a DIFFERENT one."
 */
const TOOL_RESULT_HEAD = /^ {2}⎿\s*/;

/**
 * Claude Code's own fixed copy for the banner's wrapped second line — the
 * ONLY text ever observed immediately following a genuine banner, in 97/97
 * real occurrences (BUTCHR-259 measurement, independently reproduced for
 * this fix). This is the primary false-close guard: a rendered ticket or
 * comment narrating the incident (KAN-804/807) has the refusal PHRASE
 * verbatim in its own text (that's the whole risk this module exists to
 * guard against) but has no reason to also reproduce this exact nag line,
 * verbatim, as the line immediately following it — narration talks ABOUT
 * the refusal, it doesn't re-render Claude Code's own upsell copy. Even
 * this repo's own doc quoting the banner
 * (docs/session-limit-recovery-inert-tail-window-and-hung-read.md) does not
 * pair the two lines this way. Requiring the PAIR, not just the `⎿` prefix,
 * is what a prefix-strip-only fix is missing (BUTCHR-259 AC2's warning).
 */
const BANNER_CONTINUATION = /^\/(?:upgrade|usage-credits)\b/;

/**
 * A line that is part of a bordered notification box (observed: a butchr
 * "monitor" bug-report draft, e.g. real capture CNDLX-10) rather than plain
 * scrollback — recognised ONLY by its box-drawing border, never by its
 * (arbitrary, free-text) inner content, which cannot be enumerated. Such a
 * box was observed landing directly between a genuine, still-live banner
 * and the pane's own tail in real capture data — async chrome unrelated to
 * whether the CLI session itself is refused, and it must not disqualify a
 * genuine banner's pairing from being treated as live (see embeddedAfter).
 */
const BOX_LINE = /^[╭╮╰╯│]/;

/**
 * Chrome known to legitimately follow a genuine banner's own pairing:
 * the composer prompt (bare `❯`, the "⏵⏵ bypass permissions…" line and its
 * wrapped `/rc` remnant), a completion/status line (many random verbs in
 * the real corpus — Cooked, Baked, Brewed, Sautéed, Churned, Crunched,
 * Cogitated, Worked — always "<verb> for <duration> · done H:MM"), the
 * update-available line, and the "new task?" token-count hint.
 */
const IDLE_CHROME = /^(?:❯|⏵⏵|✔|Tip:|new task\?|\/rc$)|·\s*done\s+\d{1,2}:\d{2}/;

/**
 * Recognise the "You've hit your session limit" refusal in ANSI-stripped
 * pane text and, if present, resolve the printed reset clock time to the
 * next occurrence at or after `now` (treated as LOCAL time — a 9:50pm reset
 * seen at 6:59pm is tonight; seen at 11pm it is tomorrow). `now` is
 * injected: this module does no I/O and never reaches for the clock itself.
 *
 * Collapses `classifySessionLimitText`'s `suppressed` and `not-recognised`
 * outcomes to `null` — both are correctly "not a live refusal right now"
 * for every existing caller (herd.ts's kickoff-verify/nudge gates), which
 * must not treat quoted/embedded text as blocking either. Use
 * `classifySessionLimitText` directly where the distinction (and the
 * suppression reason) matters for logging — see session-limit-watch.ts.
 */
export function detectSessionLimitRefusal(text: string, now: Date): SessionLimitRefusal | null {
  const outcome = classifySessionLimitText(text, now);
  return outcome.kind === "recognised" ? { resetsAt: outcome.resetsAt, raw: outcome.raw } : null;
}

/**
 * The detailed classification behind `detectSessionLimitRefusal`. Two
 * independent paths, tried in this order:
 *
 * 1. `⎿`-prefixed candidates (how every real banner renders): scan the
 *    WHOLE text for the MOST RECENT (closest to the end) line that, once
 *    the tool-result prefix is stripped, matches REFUSAL_LINE — not
 *    position-bounded, because BUTCHR-259 measured genuine banners sitting
 *    anywhere from content-depth 5 to 25 depending on incidental chrome
 *    (including arbitrary async notification boxes). Only the MOST RECENT
 *    such line is ever considered: an older occurrence further back is a
 *    past attempt, not current pane state — and if the agent has run
 *    anything at all since (proven by there being real content between the
 *    two), the session cannot still be the one that's refused. Once found,
 *    it is decided immediately, live or suppressed — earlier occurrences
 *    are never consulted as a fallback.
 *
 *    Decided live only if BOTH:
 *      (a) the very next raw line matches the banner's own known wrap
 *          continuation (BANNER_CONTINUATION) — the primary guard, and
 *      (b) nothing looks like FURTHER embedded content after that
 *          continuation (embeddedAfter) — a defense-in-depth guard against
 *          the worst case where an adversarial quote reproduces the full
 *          two-line pair verbatim and then keeps going (more ticket prose,
 *          a `… +N lines (ctrl+o to expand)` truncation tail).
 *    Anything else on this path is `suppressed`, with a reason.
 *
 * 2. Legacy bare-line path (see TAIL_LINES): only reached if no `⎿`-
 *    prefixed candidate was found at all. Unchanged in behaviour from
 *    before BUTCHR-259.
 */
export function classifySessionLimitText(text: string, now: Date): SessionLimitOutcome {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    // Matched against the RAW line, not the trimmed one — TOOL_RESULT_HEAD
    // itself is anchored to exactly two leading spaces, which is what
    // rejects a refusal-shaped line nested inside some OTHER, enclosing
    // tool result's continuation (margin depth >= 5, never 2).
    const head = TOOL_RESULT_HEAD.exec(line);
    if (!head) continue;
    const trimmed = line.trim();
    const rest = line.slice(head[0].length);
    const m = REFUSAL_LINE.exec(rest);
    if (!m) continue;

    const nextRaw = lines[i + 1]?.trim() ?? "";
    if (!BANNER_CONTINUATION.test(nextRaw)) {
      return {
        kind: "suppressed",
        raw: trimmed,
        reason:
          `a ⎿-prefixed refusal-shaped line is not immediately followed by its own wrap ` +
          `continuation ("${nextRaw || "<end of text>"}" instead of /upgrade or /usage-credits) — ` +
          `looks like quoted/embedded text (e.g. a rendered ticket or comment), not a live banner`,
      };
    }
    const embedReason = embeddedAfter(lines, i + 2);
    if (embedReason) return { kind: "suppressed", raw: trimmed, reason: embedReason };

    const rt = RESET_TIME.exec(rest);
    if (!rt) return { kind: "recognised", resetsAt: null, raw: rest };
    return { kind: "recognised", resetsAt: resolveResetTime(rt, now), raw: rest };
  }

  // No ⎿-prefixed candidate anywhere in the text — fall back to the legacy
  // bare-line path, unchanged from before BUTCHR-259.
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
    if (!rt) return { kind: "recognised", resetsAt: null, raw: line };
    return { kind: "recognised", resetsAt: resolveResetTime(rt, now), raw: line };
  }
  return { kind: "not-recognised" };
}

/**
 * Looks for anything AFTER a paired banner's own wrap continuation that
 * would mean the pair itself is embedded in something larger still
 * continuing — further ticket-body prose, or a `… +N lines (ctrl+o to
 * expand)` truncation tail — rather than being the pane's own, complete,
 * live tool result. Skips exactly the things observed to legitimately
 * follow a genuine, currently-live banner in real capture data: blank
 * lines, decorative rules, bordered async notification boxes (BOX_LINE —
 * arbitrary inner text, recognised by border only), and known idle-pane
 * chrome (IDLE_CHROME). Reaching the end of the text with nothing
 * unrecognised found means genuine. Anything else found first means the
 * pair is not the pane's own final word — suppressed.
 */
function embeddedAfter(lines: string[], fromIndex: number): string | null {
  for (let i = fromIndex; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || DECORATIVE.test(trimmed) || BOX_LINE.test(trimmed) || IDLE_CHROME.test(trimmed)) continue;
    return (
      `a ⎿-prefixed refusal's own wrap continuation is followed by further content ` +
      `("${trimmed.slice(0, 60)}") — looks like a fuller quoted/embedded rendering ` +
      `(more ticket prose, or a truncation tail), not a live banner`
    );
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
