import { describe, expect, test } from "bun:test";
import { watchPrompts } from "../../src/agents/prompt-watch.js";

const MENU = "Trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm";

function rig(readText: string) {
  let fire: ((p: string) => void) | null = null;
  const sent: Array<{ pane: string; text: string }> = [];
  const exposed: unknown[] = [];
  return {
    fire: (p: string) => fire!(p),
    sent, exposed,
    deps: (onPrompt: any) => ({
      onBlocked: (cb: (p: string) => void) => { fire = cb; return () => {}; },
      read: async () => readText,
      send: async (pane: string, text: string) => { sent.push({ pane, text }); },
      onPrompt,
      onExposed: (e: unknown) => exposed.push(e),
    }),
  };
}

describe("watchPrompts", () => {
  test("auto-answers when onPrompt returns a number (arrows + enter)", async () => {
    const r = rig(MENU);
    watchPrompts(r.deps(() => 2));          // choose option 2
    r.fire("w1:p1"); await Bun.sleep(5);
    expect(r.sent).toEqual([{ pane: "w1:p1", text: "\x1b[B\r" }]);  // current 1 → 2: one down + enter
    expect(r.exposed).toEqual([]);
  });
  test("exposes the prompt (no send) when onPrompt returns undefined", async () => {
    const r = rig(MENU);
    watchPrompts(r.deps(() => undefined));
    r.fire("w1:p1"); await Bun.sleep(5);
    expect(r.sent).toEqual([]);
    expect(r.exposed.length).toBe(1);
  });
  test("ignores a blocked pane whose screen is not a menu", async () => {
    const r = rig("just working, no prompt");
    watchPrompts(r.deps(() => 1));
    r.fire("w1:p1"); await Bun.sleep(5);
    expect(r.sent).toEqual([]); expect(r.exposed).toEqual([]);
  });
});

describe("continue screens", () => {
  test("'Press Enter to continue' gets a bare enter, no parsing needed", async () => {
    const sent: Array<[string, string]> = [];
    let cb: (p: string) => void = () => {};
    watchPrompts({
      onBlocked: (f) => { cb = f; return () => {}; },
      read: async () => "Security notes:\n blah blah\n Press Enter to continue…",
      send: async (p, t) => { sent.push([p, t]); },
      onPrompt: () => { throw new Error("should not be consulted"); },
    });
    cb("p9");
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([["p9", "\r"]]);
  });
});
