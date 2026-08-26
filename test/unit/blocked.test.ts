import { describe, expect, test } from "bun:test";
import { blockedNow, watchBlocked } from "../../src/agents/blocked.js";

const row = (pane_id: string, agent_status: string) => ({ pane_id, agent_status });

describe("blockedNow", () => {
  test("all currently blocked panes, sorted", () => {
    expect(blockedNow([row("p2", "blocked"), row("p1", "blocked"), row("p3", "idle")])).toEqual(["p1", "p2"]);
  });
});
describe("watchBlocked", () => {
  test("fires EVERY poll while a pane stays blocked (the KAN-682 retry)", async () => {
    const blocked: string[] = [];
    const stop = watchBlocked(async () => [row("p1", "blocked"), row("p2", "idle")], 10, (p) => blocked.push(p));
    await new Promise((r) => setTimeout(r, 45));
    stop();
    expect(blocked.filter((p) => p === "p1").length).toBeGreaterThanOrEqual(2); // retried, not one-shot
    expect(blocked).not.toContain("p2");
    const n = blocked.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(blocked.length).toBe(n); // stop() ends it
  });
  test("a failing list() reports onError and the loop survives to the next poll", async () => {
    const errs: unknown[] = []; const blocked: string[] = [];
    let n = 0;
    const stop = watchBlocked(
      async () => { if (n++ === 0) throw new Error("storm"); return [row("p1", "blocked")]; },
      10, (p) => blocked.push(p), (e) => errs.push(e),
    );
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(errs.length).toBe(1);
    expect(blocked).toContain("p1");   // survived the failed poll
  });
});
