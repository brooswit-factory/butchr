import { describe, expect, test } from "bun:test";
import { terminalCommand, detectTerminalPrefix, parseTerminalEnv, KNOWN_TERMINALS } from "../../src/terminal/open.js";

describe("terminal opener", () => {
  test("terminalCommand appends `herdr agent attach <target>` to the prefix", () => {
    expect(terminalCommand(["gnome-terminal", "--"], "w1:p3")).toEqual(["gnome-terminal", "--", "herdr", "agent", "attach", "w1:p3"]);
    expect(terminalCommand(["xterm", "-e"], "butchr:KAN-1")).toEqual(["xterm", "-e", "herdr", "agent", "attach", "butchr:KAN-1"]);
  });
  test("detectTerminalPrefix returns the first installed emulator, in preference order", () => {
    expect(detectTerminalPrefix((c) => c === "xterm")).toEqual(["xterm", "-e"]);
    // when several exist, the earliest in KNOWN_TERMINALS wins
    expect(detectTerminalPrefix((c) => c === "xterm" || c === "gnome-terminal")).toEqual(["gnome-terminal", "--"]);
    expect(detectTerminalPrefix(() => false)).toBeNull();
  });
  test("parseTerminalEnv splits a command override", () => {
    expect(parseTerminalEnv("alacritty -e")).toEqual(["alacritty", "-e"]);
    expect(parseTerminalEnv("  kitty  ")).toEqual(["kitty"]);
  });
  test("every known terminal has a non-empty prefix", () => {
    for (const [, prefix] of KNOWN_TERMINALS) expect(prefix.length).toBeGreaterThan(0);
  });
});
