import { describe, expect, test } from "bun:test";
import { buildDashboardRows, type DashboardAgent, type IssueMeta } from "../../src/agents/dashboard.js";
import { StatusFloorTracker } from "../../src/agents/status-floor.js";

function agent(name: string, status = "idle", pane = "p1"): DashboardAgent {
  return { name, agent_status: status, pane_id: pane };
}

describe("buildDashboardRows: the row shape, for both an issue-tier row and a project-tier row (BUTCHR-269)", () => {
  test("an issue-tier row (butchr-BUTCHR-1) carries all five fields: resourceKey, tier, agentStatus, pane, timeInStatus, plus confirmedAt", () => {
    const now = 12345;
    const meta = new Map<string, IssueMeta>([["BUTCHR-1", { summary: "s", issuetype: "Task" }]]);
    const rows = buildDashboardRows([agent("butchr-butchr-1", "working", "pane-1")], {
      now: () => now,
      issueMeta: (k) => meta.get(k),
      tracker: new StatusFloorTracker(() => now),
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("agent");
    expect(row.resourceKey).toBe("BUTCHR-1");
    expect(row.tier).toEqual({ kind: "issue", issuetype: { checked: true, value: "Task" } });
    expect(row.agentStatus).toBe("working");
    expect(row.pane).toBe("pane-1");
    expect(row.timeInStatus.exact).toBe(false); // first observation this poll
    expect(row.confirmedAt).toBe(new Date(now).toISOString());
  });

  test("a project-tier row (butchr-butchr, no issue-number suffix) carries tier: {kind:'project'} — no issuetype to know or decline", () => {
    const rows = buildDashboardRows([agent("butchr-butchr", "idle", "pane-2")], {
      now: () => 0,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => 0),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceKey).toBe("BUTCHR");
    expect(rows[0]!.tier).toEqual({ kind: "project" });
  });

  test("one poll's rows all share the same confirmedAt", () => {
    const now = 999;
    const rows = buildDashboardRows([agent("butchr-butchr-1"), agent("butchr-butchr-2")], {
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.confirmedAt).toBe(rows[1]!.confirmedAt);
  });

  test("an agent whose name does not resolve to a resource key is silently excluded — not a malformed row", () => {
    const rows = buildDashboardRows([{ name: null, agent_status: "idle", pane_id: "p1" }], {
      now: () => 0,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => 0),
    });
    expect(rows).toEqual([]);
  });
});

describe("buildDashboardRows: 'could not check the tier' is distinct from 'known tier', never a guessed default (BUTCHR-269 — collapse-detecting)", () => {
  test("a row whose key is absent from issueMeta reads tier.issuetype as {checked:false, declinedAt}, never a guessed task/story/epic", () => {
    const now = 500;
    const rows = buildDashboardRows([agent("butchr-butchr-1")], {
      now: () => now,
      issueMeta: () => undefined, // genuinely unavailable — fresh daemon, or key dropped mid-search
      tracker: new StatusFloorTracker(() => now),
    });
    const tier = rows[0]!.tier;
    if (tier.kind !== "issue") throw new Error("expected an issue-tier row");
    expect(tier.issuetype).toEqual({ checked: false, declinedAt: new Date(now).toISOString() });
  });

  test("a row whose key IS in issueMeta reads tier.issuetype as {checked:true, value}, distinguishably from the declined case above", () => {
    const now = 500;
    const meta = new Map<string, IssueMeta>([["BUTCHR-1", { summary: "s", issuetype: "Story" }]]);
    const rows = buildDashboardRows([agent("butchr-butchr-1")], {
      now: () => now,
      issueMeta: (k) => meta.get(k),
      tracker: new StatusFloorTracker(() => now),
    });
    const tier = rows[0]!.tier;
    if (tier.kind !== "issue") throw new Error("expected an issue-tier row");
    expect(tier.issuetype).toEqual({ checked: true, value: "Story" });
    // THE DISTINCTION ITSELF, asserted directly: `checked` differs between
    // the known and unavailable cases — a test that only checked one of the
    // two branches would not catch them being silently collapsed into one
    // shape (e.g. both defaulting `value` to "" on missing metadata).
    expect(tier.issuetype.checked).toBe(true);
  });
});

describe("buildDashboardRows: forgetMissing runs every poll, so a disappeared agent's floor does not leak into a later reappearance (BUTCHR-269)", () => {
  test("an agent absent from THIS poll's agents array drops out of the tracker — a later reappearance starts a fresh, inexact floor", () => {
    let now = 0;
    const tracker = new StatusFloorTracker(() => now);
    buildDashboardRows([agent("butchr-butchr-1", "working")], { now: () => now, issueMeta: () => undefined, tracker });
    now = 5 * 60_000;
    const exact = buildDashboardRows([agent("butchr-butchr-1", "idle")], { now: () => now, issueMeta: () => undefined, tracker })[0]!;
    expect(exact.timeInStatus.exact).toBe(true); // real transition, witnessed

    now = 10 * 60_000;
    buildDashboardRows([], { now: () => now, issueMeta: () => undefined, tracker }); // BUTCHR-1 absent this poll

    now = 20 * 60_000;
    const reappeared = buildDashboardRows([agent("butchr-butchr-1", "idle")], { now: () => now, issueMeta: () => undefined, tracker })[0]!;
    expect(reappeared.timeInStatus.exact).toBe(false); // fresh episode, not inheriting the 5min floor
    expect(reappeared.timeInStatus.sinceMs).toBe(20 * 60_000);
  });
});
