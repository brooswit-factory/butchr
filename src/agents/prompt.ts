/** A parsed selection prompt from a blocked agent's screen. */
export interface Prompt {
  question: string;
  options: string[];   // in order, 1-based when presented to a responder
  current: number;     // 1-based index of the highlighted option (the ❯), or 1
}

/**
 * How many lines immediately preceding the menu can be the "question". A real
 * dialog question is short and sits directly above its options; anything
 * further up is prior pane output (command output, previous turns) by
 * definition and must never reach `question`. Shared by both branches below
 * so they cannot drift apart on how much they leak.
 */
const QUESTION_TAIL = 6;

/**
 * A real Claude Code selection dialog always ends with this footer,
 * IMMEDIATELY after its last option (blank lines allowed in between, never
 * other content). It is NOT enough to check that this phrase merely occurs
 * somewhere in the text — KAN-756's real captures (comment 14863) proved
 * that trap: a working agent's own narration ("no Enter to confirm footer
 * detected here") contains the phrase as ordinary prose, far from any real
 * menu. The position relative to the options — not the phrase's presence —
 * is the signal.
 *
 * Anchored to the START of the line (PR #40 review, comment 14956): a real
 * footer IS the line, never a clause inside a sentence. Every footer line
 * in every real fixture in this repo begins with this phrase once trimmed
 * — an un-anchored match let a narration sentence merely CONTAINING the
 * phrase satisfy the gate (the exact self-sustaining loop mechanism this
 * whole ticket exists to close: an escalation comment quotes a real
 * dialog's footer onto a ticket, the agent reads that ticket, and the
 * phrase is now sitting in its own pane as prose).
 */
const FOOTER = /^\s*Enter to (confirm|select)/;

/**
 * Parse herdr's `pane.read source:detection` text of a blocked Claude prompt.
 * Recognizes the `❯ N. label` / `  N. label` numbered-menu shape. Returns null
 * if the text is not a selection prompt.
 *
 * KAN-756: real captures on the affected fleet proved the trigger is not any
 * specific banner but ANY two "N. label" lines anywhere in a WORKING agent's
 * scrollback — including a pane merely quoting option strings out of a Jira
 * comment (a self-sustaining loop: butchr escalates, the escalation comment
 * quotes the options, the agent reads its ticket, the pane now contains
 * those same two lines, butchr escalates again). Two independent structural
 * gates close it, matched against the real captures: the footer must
 * immediately follow the LAST option (the same walk-upward discipline
 * parseUnnumbered already uses for its own menu block), and exactly one
 * option line must carry the ❯ cursor. Neither alone suffices — a footer
 * phrase can appear as unrelated prose, and a stray "❯" can appear as a
 * shell-prompt echo — so both are required and tested independently.
 */
export function parsePrompt(text: string): Prompt | null {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const options: string[] = [];
  let current = 1;
  let cursorCount = 0;
  let lastOptionLineIdx = -1;
  const questionLines: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const m = /^\s*(❯|>)?\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      const idx = Number(m[2]);
      if (m[1]) { current = idx; cursorCount++; }
      options[idx - 1] = m[3]!.trim();
      lastOptionLineIdx = li;
    } else if (line.trim() && !/^(Enter to confirm|Esc to cancel|─+|·)/.test(line.trim())) {
      if (options.length === 0) questionLines.push(line.trim());
    }
  }
  const opts = options.filter((o) => o !== undefined);
  // Fewer than two numbered lines isn't a numbered menu at all — fall
  // through to the un-numbered shape. Two or more IS numbered-shaped; from
  // here it is this menu or nothing — a numbered block that fails the
  // cursor/footer gate must never be reinterpreted as un-numbered content
  // (its own lines, "1. a" etc., would otherwise be misread as literal
  // un-numbered option text).
  if (opts.length < 2) return parseUnnumbered(lines);
  if (cursorCount !== 1 || !footerImmediatelyFollows(lines, lastOptionLineIdx)) return null;
  return {
    question: questionLines.slice(-QUESTION_TAIL).join(" ").trim(),
    options: opts,
    current: Math.min(Math.max(current, 1), opts.length),
  };
}

/**
 * True if the FIRST footer-shaped line strictly after `lastOptionLineIdx`
 * is separated from it only by blank lines — i.e. the footer is the very
 * next non-blank thing after the menu, not merely present somewhere later
 * in the pane. `lastOptionLineIdx === -1` (no options collected) is always
 * false.
 */
function footerImmediatelyFollows(lines: string[], lastOptionLineIdx: number): boolean {
  if (lastOptionLineIdx === -1) return false;
  const footerIdx = lines.findIndex((l, idx) => idx > lastOptionLineIdx && FOOTER.test(l));
  if (footerIdx === -1) return false;
  return lines.slice(lastOptionLineIdx + 1, footerIdx).every((l) => !l.trim());
}

/**
 * The un-numbered menu shape (Claude Code's trust dialog since ~2.x): a block
 * of short option lines, one carrying `❯`, terminated by an
 * "Enter to confirm/select · Esc" footer. The footer is REQUIRED — it is the
 * gate that keeps arbitrary prose from parsing as a menu.
 *
 * Anchors to the LAST line-start match of FOOTER, not the first (PR #40
 * review, comment 14983): a real dialog is always the LAST thing rendered
 * in a pane's scrollback, so prose mentioning the footer phrase ABOVE a
 * genuine dialog must never steal the anchor from the real one below it.
 */
function parseUnnumbered(lines: string[]): Prompt | null {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i]!)) { footerIdx = i; break; }
  }
  if (footerIdx < 1) return null;
  const options: string[] = [];
  let current = -1;
  let i = footerIdx - 1;
  while (i >= 0 && options.length < 8) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) { if (options.length) break; i--; continue; }
    const m = /^\s*(❯|>)\s+(.*)$/.exec(line);
    if (m) { options.unshift(m[2]!.trim()); current = 0; }
    else if (/^\s{2,}\S/.test(line) && t.length <= 80 && !/[.:]$/.test(t)) options.unshift(t);
    else break;
    if (m) { /* keep scanning above the marker */ }
    i--;
  }
  // current = index of the ❯ option within the collected block
  if (options.length < 2 || current === -1) return null;
  // find which collected option carried the marker: re-scan for it
  let cur = 1;
  let seen = 0;
  for (let j = footerIdx - 1; j >= 0 && seen < options.length; j--) {
    const t = lines[j]!.trim();
    if (!t) continue;
    seen++;
    if (/^\s*(❯|>)\s+/.test(lines[j]!)) { cur = options.length - seen + 1; break; }
  }
  const question = lines.slice(0, footerIdx - options.length).map((l) => l.trim())
    .filter((t) => t && !/^(─+|·)/.test(t)).slice(-QUESTION_TAIL).join(" ").trim();
  return { question, options, current: cur };
}

/**
 * Pick which option answers a routine startup prompt, by CONTENT — scanning
 * every option, never assuming option 1. Claude Code's trust dialog now lists
 * "No, exit" FIRST, so a hardcoded 1 would kill the agent. Returns the 1-based
 * option index, or null to leave the prompt for a human.
 */
export function chooseStartupAnswer(prompt: Prompt): number | null {
  // The Bypass-Permissions first-run acceptance: our fleet runs bypass by
  // design, and "No, exit" is listed first — match the accept option by content.
  if (/Bypass Permissions/i.test(prompt.question)) {
    for (let i = 0; i < prompt.options.length; i++)
      if (/accept/i.test(prompt.options[i]!) && !/exit|no,/i.test(prompt.options[i]!)) return i + 1;
    return null;
  }
  // The fullscreen-renderer offer: non-work UI opt-in that strands agents at
  // the composer. Fleet's standing answer (given by an epic three times before
  // this was automated): Not now.
  if (/fullscreen renderer/i.test(prompt.question)) {
    for (let i = 0; i < prompt.options.length; i++)
      if (/not now/i.test(prompt.options[i]!)) return i + 1;
    return null;
  }
  const ANSWER = /I trust this folder|local development|resume from summary/i;
  for (let i = 0; i < prompt.options.length; i++)
    if (ANSWER.test(prompt.options[i]!)) return i + 1;
  // settings-warning style dialogs keep the acknowledgement wording in the
  // question with a bare continue/ok option
  if (/settings warning/i.test(prompt.question)) {
    for (let i = 0; i < prompt.options.length; i++)
      if (/continue|ok|yes/i.test(prompt.options[i]!) && !/exit|no/i.test(prompt.options[i]!)) return i + 1;
  }
  return null;
}

/**
 * The keystrokes to move from the currently-highlighted option to `target`
 * (1-based) and confirm. Arrow navigation is used rather than number keys
 * because it works whether or not the menu binds digits.
 */
export function keysToSelect(current: number, target: number): string {
  const delta = target - current;
  const arrow = delta > 0 ? "\x1b[B" : "\x1b[A"; // down / up
  return arrow.repeat(Math.abs(delta)) + "\r";
}
