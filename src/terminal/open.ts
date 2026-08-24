/**
 * Opening an agent's interactive shell in a desktop terminal window: butchr
 * spawns the user's terminal emulator running `herdr agent attach <target>`.
 * The emulator invocation differs per emulator (`-e` vs `--`), so the prefix is
 * detected or configured; the rest is uniform.
 */
export function terminalCommand(prefix: readonly string[], target: string): string[] {
  return [...prefix, "herdr", "agent", "attach", target];
}

/** Known emulators, most-preferred first, with the flag that means "run this command". */
export const KNOWN_TERMINALS: ReadonlyArray<readonly [string, string[]]> = [
  ["gnome-terminal", ["gnome-terminal", "--"]],
  ["konsole", ["konsole", "-e"]],
  ["alacritty", ["alacritty", "-e"]],
  ["kitty", ["kitty"]],
  ["wezterm", ["wezterm", "-e"]],
  ["xterm", ["xterm", "-e"]],
  ["x-terminal-emulator", ["x-terminal-emulator", "-e"]],
];

/** First installed emulator's prefix, or null if none found. `has` checks PATH. */
export function detectTerminalPrefix(has: (cmd: string) => boolean): string[] | null {
  for (const [cmd, prefix] of KNOWN_TERMINALS) if (has(cmd)) return [...prefix];
  return null;
}

/** Parse a `BUTCHR_TERMINAL` override ("alacritty -e") into a prefix. */
export const parseTerminalEnv = (v: string): string[] => v.trim().split(/\s+/).filter(Boolean);
