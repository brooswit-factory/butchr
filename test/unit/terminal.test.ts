import { describe, expect, test } from "bun:test";
import { terminalCommand, detectTerminalPrefix, parseTerminalEnv, KNOWN_TERMINALS, resolveAttach, attachRefusalMessage, hasDesktopDisplay, MACOS_TERMINAL_PREFIX } from "../../src/terminal/open.js";

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

// macOS Terminal.app takes no command on its argv, so it is scripted through
// osascript. The generated line has to survive two quoting layers (the shell
// Terminal starts, then the AppleScript string literal around it).
describe("macOS Terminal.app", () => {
  const scriptOf = (target: string) => {
    const argv = terminalCommand(MACOS_TERMINAL_PREFIX, target);
    expect(argv[0]).toBe("osascript");
    expect(argv.filter((a) => a === "-e")).toHaveLength(2);
    return argv[2]!;
  };

  test("runs `herdr agent attach <target>` in a new Terminal window and brings it forward", () => {
    expect(terminalCommand(MACOS_TERMINAL_PREFIX, "w1:p3")).toEqual([
      "osascript",
      "-e", `tell application "Terminal" to do script "herdr agent attach 'w1:p3'"`,
      "-e", `tell application "Terminal" to activate`,
    ]);
  });

  test("a target with shell and AppleScript metacharacters is quoted for both layers", () => {
    // shell: it's single-quoted with an embedded quote written as '\''
    // AppleScript: backslash and double quote are escaped inside the literal
    expect(scriptOf(`a'b`)).toBe(`tell application "Terminal" to do script "herdr agent attach 'a'\\\\''b'"`);
    expect(scriptOf(`a"b`)).toBe(`tell application "Terminal" to do script "herdr agent attach 'a\\"b'"`);
    expect(scriptOf(`a\\b`)).toBe(`tell application "Terminal" to do script "herdr agent attach 'a\\\\b'"`);
    expect(scriptOf("x; echo SHOULD-NOT-RUN")).toBe(`tell application "Terminal" to do script "herdr agent attach 'x; echo SHOULD-NOT-RUN'"`);
  });

  test("the prefix is only special as the whole prefix: anything else keeps the argv form", () => {
    expect(terminalCommand(["macos-terminal", "-e"], "w1:p3")).toEqual(["macos-terminal", "-e", "herdr", "agent", "attach", "w1:p3"]);
  });

  test("detectTerminalPrefix prefers Terminal.app on darwin, even when an X11 emulator is installed", () => {
    expect(detectTerminalPrefix((c) => c === "osascript" || c === "xterm", "darwin")).toEqual(["macos-terminal"]);
  });

  test("on darwin without osascript it falls back to the known list, and other platforms ignore osascript", () => {
    expect(detectTerminalPrefix((c) => c === "xterm", "darwin")).toEqual(["xterm", "-e"]);
    expect(detectTerminalPrefix((c) => c === "osascript", "linux")).toBeNull();
    expect(detectTerminalPrefix((c) => c === "osascript" || c === "xterm", "linux")).toEqual(["xterm", "-e"]);
  });

  test("BUTCHR_TERMINAL=macos-terminal parses to the same prefix", () => {
    expect(parseTerminalEnv("macos-terminal")).toEqual([...MACOS_TERMINAL_PREFIX]);
  });

  test("a live pane on darwin resolves to the osascript argv", () => {
    const r = resolveAttach("w1:p3", ["w1:p3"], MACOS_TERMINAL_PREFIX, hasDesktopDisplay({}, "darwin"));
    expect(r).toEqual({ ok: true, argv: terminalCommand(MACOS_TERMINAL_PREFIX, "w1:p3") });
  });
});

describe("hasDesktopDisplay", () => {
  test("X11 and Wayland hosts say so through the environment", () => {
    expect(hasDesktopDisplay({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(hasDesktopDisplay({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(hasDesktopDisplay({}, "linux")).toBe(false);
    expect(hasDesktopDisplay({ DISPLAY: "" }, "linux")).toBe(false);
  });
  test("macOS has no such variable, so a display is assumed there", () => {
    expect(hasDesktopDisplay({}, "darwin")).toBe(true);
  });
});

// BUTCHR-267: `resolveAttach` is the pure decision behind the pane-keyed
// terminal-attach link (dashboard row → GET route → this). Pane ids contain
// a colon (`w1:p3`, as above) — every case below uses one to prove that
// character never trips the pane-validation or command-construction logic.
describe("resolveAttach (BUTCHR-267 pane-keyed attach decision)", () => {
  const LIVE = ["w1:p3", "w2:p1"];
  const PREFIX = ["xterm", "-e"];

  test("a live pane with a display and a terminal prefix launches", () => {
    const r = resolveAttach("w1:p3", LIVE, PREFIX, true);
    expect(r).toEqual({ ok: true, argv: ["xterm", "-e", "herdr", "agent", "attach", "w1:p3"] });
  });

  test("a pane not in the live registry is refused as unknown-pane — never reaches display/terminal checks", () => {
    // No display AND no terminal prefix, so if unknown-pane weren't checked
    // first this would (wrongly) surface as one of the other two refusals.
    const r = resolveAttach("attacker:supplied", LIVE, null, false);
    expect(r).toEqual({ ok: false, refusal: { reason: "unknown-pane", pane: "attacker:supplied" } });
  });

  test("a typo'd pane close to a real one is still refused, not fuzzy-matched", () => {
    const r = resolveAttach("w1:p30", LIVE, PREFIX, true);
    expect(r).toEqual({ ok: false, refusal: { reason: "unknown-pane", pane: "w1:p30" } });
  });

  test("a live pane but no display is refused as no-display, before the terminal check", () => {
    const r = resolveAttach("w1:p3", LIVE, null, false);
    expect(r).toEqual({ ok: false, refusal: { reason: "no-display" } });
  });

  test("a live pane with a display but no configured/detected terminal is refused as no-terminal", () => {
    const r = resolveAttach("w1:p3", LIVE, null, true);
    expect(r).toEqual({ ok: false, refusal: { reason: "no-terminal" } });
  });
});

describe("attachRefusalMessage (BUTCHR-267 — the browser's whole reporting surface)", () => {
  test("unknown-pane names the pane and says why it's refused", () => {
    const msg = attachRefusalMessage({ reason: "unknown-pane", pane: "w1:p3" });
    expect(msg).toContain("w1:p3");
    expect(msg).toContain("not one of this daemon's own running agents");
  });
  test("no-display names the env vars it checked, is scoped to what was actually measured, and says what fixes it", () => {
    // BUTCHR-267 [correction]: on at least one real daemon this is not a rare
    // branch, it is the ONLY branch that ever runs — so the wording must not
    // over-claim ("a terminal window cannot be opened here", a flat claim
    // about the host) beyond what two unset env vars in this process prove,
    // and it must be actionable (name the fix) rather than leave a reader stuck.
    const msg = attachRefusalMessage({ reason: "no-display" });
    expect(msg).toContain("DISPLAY");
    expect(msg).toContain("WAYLAND_DISPLAY");
    expect(msg).toContain("own process");
    expect(msg).not.toMatch(/cannot be opened here/);
    expect(msg.toLowerCase()).toContain("systemd unit");
  });
  test("no-terminal names the override an operator can set", () => {
    const msg = attachRefusalMessage({ reason: "no-terminal" });
    expect(msg).toContain("BUTCHR_TERMINAL");
  });
  test("all three refusal messages are distinct from one another", () => {
    const msgs = new Set([
      attachRefusalMessage({ reason: "unknown-pane", pane: "x" }),
      attachRefusalMessage({ reason: "no-display" }),
      attachRefusalMessage({ reason: "no-terminal" }),
    ]);
    expect(msgs.size).toBe(3);
  });
});
