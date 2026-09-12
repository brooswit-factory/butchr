import { describe, expect, test } from "bun:test";
import { watchPrompts } from "../../src/agents/prompt-watch.js";
import { chooseStartupAnswer, type Prompt } from "../../src/agents/prompt.js";

const MENU = "Trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm";

function rig(readText: string) {
  let fire: ((p: string, seq: number) => void) | null = null;
  const sent: Array<{ pane: string; text: string }> = [];
  const exposed: unknown[] = [];
  return {
    fire: (p: string) => fire!(p, 1),
    sent, exposed,
    deps: (onPrompt: any) => ({
      onBlocked: (cb: (p: string, seq: number) => void) => { fire = cb; return () => {}; },
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

describe("unparseable blocked panes are never silently dropped (KAN-756, item C)", () => {
  test("a blocked pane whose text never parses is reported via onUnparseable, not dropped", async () => {
    let fire: ((p: string, seq: number) => void) | null = null;
    const reported: Array<{ paneId: string; text: string; pollSeq: number }> = [];
    watchPrompts({
      onBlocked: (cb) => { fire = cb; return () => {}; },
      read: async () => "just working, tool output, no dialog here",
      send: async () => {},
      onPrompt: () => { throw new Error("should not be consulted — nothing parsed"); },
      onUnparseable: (e) => reported.push(e),
    });
    fire!("p1", 7);
    await Bun.sleep(5);
    expect(reported).toEqual([{ paneId: "p1", text: "just working, tool output, no dialog here", pollSeq: 7 }]);
  });

  test("pollSeq threads through onExposed and onPrompt for a parseable prompt", async () => {
    let fire: ((p: string, seq: number) => void) | null = null;
    const exposed: unknown[] = [];
    let promptSeq: number | undefined;
    watchPrompts({
      onBlocked: (cb) => { fire = cb; return () => {}; },
      read: async () => MENU,
      send: async () => {},
      onPrompt: (e) => { promptSeq = e.pollSeq; return undefined; },
      onExposed: (e) => exposed.push(e),
    });
    fire!("p1", 3);
    await Bun.sleep(5);
    expect(promptSeq).toBe(3);
    expect((exposed[0] as { pollSeq: number }).pollSeq).toBe(3);
  });
});

describe("continue screens", () => {
  for (const selected of [1, 2]) {
    test(`Codex trust with option ${selected} selected follows choice policy instead of footer`, async () => {
      const text = `> You are in /tmp/probe\n\nDo you trust the contents of this directory?\nWorking with untrusted contents comes with higher risk of prompt injection.\nTrusting the directory allows project-local config, hooks, and exec policies to load.\n\n${selected === 1 ? "›" : " "} 1. Yes, continue\n${selected === 2 ? "›" : " "} 2. No, quit\n\nPress enter to continue`;
      const r = rig(text);
      const seen: Prompt[] = [];
      watchPrompts(r.deps(({ prompt }: { prompt: Prompt }) => {
        seen.push(prompt);
        return chooseStartupAnswer(prompt);
      }));
      r.fire("p1"); await Bun.sleep(5);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.current).toBe(selected);
      expect(seen[0]!.options).toEqual(["Yes, continue", "No, quit"]);
      expect(r.sent).toEqual([]);
      expect(r.exposed).toHaveLength(1);
    });
  }

  test("continue-footer menu honors an explicit policy choice and current selection", async () => {
    const r = rig("Choose mode\n  1. Continue\n› 2. Quit\nPress enter to continue");
    watchPrompts(r.deps(() => 1));
    r.fire("p1"); await Bun.sleep(5);
    expect(r.sent).toEqual([{ pane: "p1", text: "\x1b[A\r" }]);
    expect(r.exposed).toEqual([]);
  });

  test("unparseable choices with an Enter footer never fall back to ACK", async () => {
    const r = rig("Trust directory?\n  1. Yes, continue\n  2. No, quit\nPress enter to continue");
    const reported: unknown[] = [];
    watchPrompts({ ...r.deps(() => { throw new Error("no parsed choice"); }), onUnparseable: e => reported.push(e) });
    r.fire("p1"); await Bun.sleep(5);
    expect(r.sent).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  test("'Press Enter to continue' gets a bare enter, no parsing needed", async () => {
    const sent: Array<[string, string]> = [];
    let cb: (p: string, seq: number) => void = () => {};
    watchPrompts({
      onBlocked: (f) => { cb = f; return () => {}; },
      read: async () => "Security notes:\n blah blah\n Press Enter to continue…",
      send: async (p, t) => { sent.push([p, t]); },
      onPrompt: () => { throw new Error("should not be consulted"); },
    });
    cb("p9", 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([["p9", "\r"]]);
  });
});
