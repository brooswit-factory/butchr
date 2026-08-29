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

  // KAN-756, item (A): a caller needs to see the polls a pane was NOT
  // blocked on too, or it cannot tell "still blocked, same fingerprint" from
  // "blocked again after a gap" — the flicker case. onTick fires once per
  // tick with the full blocked set, synchronously, before any per-pane
  // onBlocked call for that tick.
  test("onTick fires once per poll with the full blocked set and a strictly increasing sequence number", async () => {
    let n = 0;
    const ticks: Array<{ ids: readonly string[]; seq: number }> = [];
    const blocked: Array<{ pane: string; seq: number }> = [];
    const stop = watchBlocked(
      async () => (n++ % 2 === 0 ? [row("p1", "blocked")] : [row("p2", "blocked")]),
      10,
      (pane, seq) => blocked.push({ pane, seq }),
      undefined,
      (ids, seq) => ticks.push({ ids, seq }),
    );
    await new Promise((r) => setTimeout(r, 45));
    stop();
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]!.seq).toBe(1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.seq).toBe(ticks[i - 1]!.seq + 1);
    expect(ticks[0]!.ids).toEqual(["p1"]);
    expect(ticks[1]!.ids).toEqual(["p2"]);
    // each onBlocked call for a pane carries the SAME seq as that tick's onTick
    for (const b of blocked) {
      const t = ticks.find((t) => t.seq === b.seq);
      expect(t?.ids).toContain(b.pane);
    }
  });

  test("onTick fires with an empty array on a tick where nothing is blocked", async () => {
    let n = 0;
    const ticks: Array<readonly string[]> = [];
    const stop = watchBlocked(
      async () => (n++ === 0 ? [row("p1", "blocked")] : []),
      10,
      () => {},
      undefined,
      (ids) => ticks.push(ids),
    );
    await new Promise((r) => setTimeout(r, 35));
    stop();
    expect(ticks[0]).toEqual(["p1"]);
    expect(ticks.slice(1).every((ids) => ids.length === 0)).toBe(true);
  });
});
