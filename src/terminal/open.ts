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

/**
 * The three ways a pane-keyed terminal-attach link (BUTCHR-267) can refuse,
 * chosen to be a specific, human-readable message rather than a generic
 * "could not open" a person clicking a link has no way to act on.
 */
export type AttachRefusal =
  | { reason: "unknown-pane"; pane: string }
  | { reason: "no-display" }
  | { reason: "no-terminal" };

/** Renders an `AttachRefusal` as the exact text a browser should show. */
export function attachRefusalMessage(r: AttachRefusal): string {
  switch (r.reason) {
    case "unknown-pane":
      return `no such live pane: ${r.pane} (not one of this daemon's own running agents)`;
    case "no-display":
      return "this daemon's own process has neither DISPLAY nor WAYLAND_DISPLAY set, so it cannot launch a terminal window itself — if this host does have a display, set DISPLAY (or WAYLAND_DISPLAY) in the daemon's own environment (e.g. its systemd unit) and restart it";
    case "no-terminal":
      return "no terminal emulator found on this host (set BUTCHR_TERMINAL, e.g. \"alacritty -e\")";
  }
}

/**
 * Pure decision for the pane-keyed attach link: given the pane the link
 * named, the daemon's own live pane registry, its resolved terminal prefix,
 * and whether it has a display to reach, decides whether to launch (and the
 * exact argv, via `terminalCommand`) or which refusal applies.
 *
 * Order is deliberate: an unknown pane is refused first, regardless of
 * terminal/display state — a typo'd or attacker-supplied pane should never
 * be told "no display" as though it were otherwise a valid target (BUTCHR-267
 * AC4). Between the two environment-level refusals, "no display" is checked
 * first since it is the more fundamental problem — no terminal window can
 * ever appear on this host regardless of which emulator is configured.
 */
export function resolveAttach(
  pane: string,
  livePanes: readonly string[],
  terminalPrefix: readonly string[] | null,
  hasDisplay: boolean,
): { ok: true; argv: string[] } | { ok: false; refusal: AttachRefusal } {
  if (!livePanes.includes(pane)) return { ok: false, refusal: { reason: "unknown-pane", pane } };
  if (!hasDisplay) return { ok: false, refusal: { reason: "no-display" } };
  if (!terminalPrefix) return { ok: false, refusal: { reason: "no-terminal" } };
  return { ok: true, argv: terminalCommand(terminalPrefix, pane) };
}
