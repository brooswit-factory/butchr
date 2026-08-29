import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectSessionLimitRefusal } from "../../src/agents/session-limit.js";
import { parsePrompt } from "../../src/agents/prompt.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("detectSessionLimitRefusal", () => {
  test("recognises a genuine refusal as the last rendered content, and parses the pm reset time", () => {
    const now = new Date(2026, 7, 28, 18, 59, 0); // 6:59pm — before the 9:50pm reset, same day
    const r = detectSessionLimitRefusal(fixture("pane-cap-session-limit.txt"), now);
    expect(r).not.toBeNull();
    expect(r!.raw).toContain("You've hit your session limit");
    expect(r!.resetsAt).toBe(new Date(2026, 7, 28, 21, 50, 0).getTime());
  });

  test("tolerates 'H:MMam/pm' with no space, 'H:MM AM/PM' with a space, and 24-hour form", () => {
    const now = new Date(2026, 7, 28, 6, 0, 0);
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 9:50am", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 9, 50, 0).getTime());
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 9:50 AM", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 9, 50, 0).getTime());
    expect(detectSessionLimitRefusal("You've hit your session limit · resets 21:50", now)!.resetsAt)
      .toBe(new Date(2026, 7, 28, 21, 50, 0).getTime());
  });

  test("rolls to tomorrow when the printed clock time has already passed today", () => {
    const now = new Date(2026, 7, 28, 23, 0, 0); // 11pm
    const r = detectSessionLimitRefusal("You've hit your session limit · resets 9:50pm", now);
    expect(r!.resetsAt).toBe(new Date(2026, 7, 29, 21, 50, 0).getTime());
  });

  test("still recognises the refusal but reports no resetsAt when no reset time is printed — never invents one", () => {
    const r = detectSessionLimitRefusal("You've hit your session limit", new Date(2026, 7, 28, 12, 0, 0));
    expect(r).not.toBeNull();
    expect(r!.resetsAt).toBeNull();
  });

  test("null for ordinary text with no refusal", () => {
    expect(detectSessionLimitRefusal("just some normal output\nwith no refusal in it", new Date())).toBeNull();
  });

  // KAN-804 comment 15380/15383: this exact phrase sits verbatim in the
  // ticket's own text, so it WILL appear in scrollback whenever an agent
  // reads KAN-804 or KAN-807. A matcher that fires on that scrollback would
  // close a perfectly healthy agent's pane — worse than a missed detection.
  test("does NOT match the phrase quoted mid-scrollback, with real content (including the composer) after it", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-session-limit-midscroll.txt"), new Date())).toBeNull();
  });

  test("does NOT match a pane that has read this very ticket (the phrase inside a rendered Jira comment/tool result), with the agent still visibly active afterward", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-session-limit-quoted-ticket.txt"), new Date())).toBeNull();
  });

  test("does NOT match an ordinary healthy working-agent capture", () => {
    expect(detectSessionLimitRefusal(fixture("pane-cap-a.txt"), new Date())).toBeNull();
    expect(detectSessionLimitRefusal(fixture("pane-cap-b.txt"), new Date())).toBeNull();
  });

  test("parsePrompt never parses a genuine session-limit refusal as a dialog — it is not one", () => {
    expect(parsePrompt(fixture("pane-cap-session-limit.txt"))).toBeNull();
  });
});
