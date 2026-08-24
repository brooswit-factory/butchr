import { describe, expect, test } from "bun:test";
import { newlyBlocked, watchBlocked } from "../../src/agents/blocked.js";

const row = (pane_id: string, agent_status: string) => ({ pane_id, agent_status });

describe("newlyBlocked", () => {
  test("only panes that transitioned INTO blocked", () => {
    const prev = [row("p1", "working"), row("p2", "blocked"), row("p3", "idle")];
    const next = [row("p1", "blocked"), row("p2", "blocked"), row("p3", "working"), row("p4", "blocked")];
    expect(newlyBlocked(prev, next)).toEqual(["p1", "p4"]); // p1 became blocked, p4 new+blocked; p2 already was
  });
});
describe("watchBlocked", () => {
  test("fires onBlocked when an agent becomes blocked (manual clock)", async () => {
    let cb: (() => void) | null = null;
    const clock = { setTimeout: (fn: () => void) => { cb = fn; return 1 as unknown; }, clearTimeout: () => {} };
    const states = [[row("p1", "working")], [row("p1", "working")], [row("p1", "blocked")]];
    let n = 0; const blocked: string[] = [];
    watchBlocked(async () => states[Math.min(n++, 2)]!, 5, (p) => blocked.push(p));
    // watchBlocked uses sundry.watch which uses global timers; drive with real time instead
    await new Promise((r) => setTimeout(r, 40));
    expect(blocked).toContain("p1");
  });
});
