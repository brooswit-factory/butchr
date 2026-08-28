/** A parsed selection prompt from a blocked agent's screen. */
export interface Prompt {
  question: string;
  options: string[];   // in order, 1-based when presented to a responder
  current: number;     // 1-based index of the highlighted option (the ❯), or 1
}

/**
 * Parse herdr's `pane.read source:detection` text of a blocked Claude prompt.
 * Recognizes the `❯ N. label` / `  N. label` numbered-menu shape. Returns null
 * if the text is not a selection prompt.
 */
export function parsePrompt(text: string): Prompt | null {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const options: string[] = [];
  let current = 1;
  const questionLines: string[] = [];
  for (const line of lines) {
    const m = /^\s*(❯|>)?\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      const idx = Number(m[2]);
      if (m[1]) current = idx;
      options[idx - 1] = m[3]!.trim();
    } else if (line.trim() && !/^(Enter to confirm|Esc to cancel|─+|·)/.test(line.trim())) {
      if (options.length === 0) questionLines.push(line.trim());
    }
  }
  const opts = options.filter((o) => o !== undefined);
  if (opts.length < 2) return parseUnnumbered(lines);
  return { question: questionLines.join(" ").trim(), options: opts, current: Math.min(Math.max(current, 1), opts.length) };
}

/**
 * The un-numbered menu shape (Claude Code's trust dialog since ~2.x): a block
 * of short option lines, one carrying `❯`, terminated by an
 * "Enter to confirm/select · Esc" footer. The footer is REQUIRED — it is the
 * gate that keeps arbitrary prose from parsing as a menu.
 */
function parseUnnumbered(lines: string[]): Prompt | null {
  const footerIdx = lines.findIndex((l) => /Enter to (confirm|select)/.test(l));
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
    .filter((t) => t && !/^(─+|·)/.test(t)).slice(-6).join(" ").trim();
  return { question, options, current: cur };
}

/**
 * Pick which option answers a routine startup prompt, by CONTENT — scanning
 * every option, never assuming option 1. Claude Code's trust dialog now lists
 * "No, exit" FIRST, so a hardcoded 1 would kill the agent. Returns the 1-based
 * option index, or null to leave the prompt for a human.
 */
export function chooseStartupAnswer(prompt: Prompt): number | null {
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
