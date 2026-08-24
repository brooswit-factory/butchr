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
  if (opts.length < 2) return null;
  return { question: questionLines.join(" ").trim(), options: opts, current: Math.min(Math.max(current, 1), opts.length) };
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
