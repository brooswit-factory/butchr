import { describe, expect, test } from "bun:test";
import { watchSessionLimits, POST_RESET_MARGIN_MS, type AgentRow } from "../../src/agents/session-limit-watch.js";

const row = (issue: string, agent_status: string, pane_id = `${issue.toLowerCase()}:p1`): AgentRow => ({ pane_id, agent_status, issue });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchSessionLimits", () => {
  test("cost gate: never reads the pane of a working or blocked agent", async () => {
    const reads: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "working"), row("KAN-2", "blocked")],
      read: async (p) => { reads.push(p); return ""; },
      close: async () => {},
      now: () => Date.now(),
      log: () => {},
    }, 10);
    await wait(30);
    stop();
    expect(reads).toEqual([]);
  });

  test("no refusal in an idle/done pane -> never logs, never closes", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => "just an ordinary idle pane",
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("refused with a parseable reset time: logs once (deduplicated) before the reset, never closes early, closes at reset+margin, and stays idempotent afterward", async () => {
    const closed: string[] = []; const logs: string[] = [];
    let nowMs = 1_000_000; // arbitrary anchor, well before any resolved resetsAt
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "done")],
      read: async () => "You've hit your session limit · resets 9:50pm",
      close: async (i) => { closed.push(i); },
      now: () => nowMs,
      log: (l) => logs.push(l),
    }, 5);
    await wait(30); // several polls before any reset — all should just log, deduplicated
    expect(closed).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("KAN-1");
    expect(logs[0]).toContain("resets");

    // Jump `now` to exactly the resolved resetsAt + margin (computed the same
    // way detectSessionLimitRefusal would, from the log line's own math is
    // avoided here — instead derive it directly to keep the test independent
    // of log wording): resolve 9:50pm relative to the anchor instant.
    const anchor = new Date(nowMs);
    const resetsAt = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 21, 50, 0).getTime();
    const target = resetsAt >= nowMs ? resetsAt : resetsAt + 24 * 60 * 60_000;
    nowMs = target + POST_RESET_MARGIN_MS;
    await wait(30);
    stop();
    expect(closed.length).toBeGreaterThanOrEqual(1); // idempotent: repeated polls past the margin may close repeatedly, which herd.stop() already tolerates
    expect(closed.every((i) => i === "KAN-1")).toBe(true);
  });

  test("refusal with no parseable reset time: logs that recovery cannot be scheduled, never invents a time, never closes", async () => {
    const closed: string[] = []; const logs: string[] = [];
    const stop = watchSessionLimits({
      list: async () => [row("KAN-1", "idle")],
      read: async () => "You've hit your session limit",
      close: async (i) => { closed.push(i); },
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(closed).toEqual([]);
    expect(logs.some((l) => l.includes("cannot schedule recovery"))).toBe(true);
  });

  test("a failing list() poll survives to the next poll", async () => {
    const logs: string[] = [];
    let n = 0;
    const stop = watchSessionLimits({
      list: async () => { if (n++ === 0) throw new Error("herdr down"); return [row("KAN-1", "idle")]; },
      read: async () => "",
      close: async () => {},
      now: () => Date.now(),
      log: (l) => logs.push(l),
    }, 10);
    await wait(30);
    stop();
    expect(logs.some((l) => l.includes("poll failed"))).toBe(true);
  });
});
