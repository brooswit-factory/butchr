import { describe, expect, test } from "bun:test";
import { buildDashboardRows, createDashboardFeed, initialDashboardSnapshot, type DashboardAgent, type IssueMeta } from "../../src/agents/dashboard.js";
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

// BUTCHR-308: the "could not check" decision itself — what `/dashboard`'s
// snapshot looks like after a poll succeeds or fails — used to live only
// inside `src/daemon/index.ts`'s `agentStatuses` provider, a module no unit
// test in this repo imports (see `createDashboardFeed`'s own doc comment).
// `createDashboardFeed` moves that decision here; these tests drive it
// directly, with a fake `list()` standing in for `herdr.agent.list()`. The
// epic's own falsifier — a declined poll that discards `rows`, or one that
// launders `checked` to `true` — is exactly what "byte-identical prior rows"
// and "checked:false" below would catch: mutate either behaviour in
// `createDashboardFeed` and the failing-poll test fails.
describe("createDashboardFeed: the could-not-check decision, unit-tested directly (BUTCHR-308)", () => {
  function feed(now: () => number) {
    return createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now) });
  }

  test("before any poll, the snapshot is checked:false with no rows — 'could not check', never 'fleet empty'", () => {
    const f = feed(() => 0);
    expect(f.snapshot()).toEqual(initialDashboardSnapshot(() => 0));
    expect(f.snapshot().checked).toBe(false);
    expect(f.snapshot().rows).toEqual([]);
  });

  test("repeated snapshot() reads never call list() again and never change confirmedAt", async () => {
    let calls = 0;
    let now = 1000;
    const f = feed(() => now);
    await f.poll(async () => {
      calls++;
      return { agents: [agent("butchr-butchr-1", "working")] };
    });
    expect(calls).toBe(1);

    now = 9000; // the clock moves between reads; only a poll may advance confirmedAt
    const first = f.snapshot();
    const second = f.snapshot();
    const third = f.snapshot();
    expect(calls).toBe(1); // snapshot() itself never touches list()
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    if (!first.checked) throw new Error("expected checked:true");
    expect(first.confirmedAt).toBe(new Date(1000).toISOString());
  });

  test("a successful poll advances confirmedAt (and rebuilds rows) on each call", async () => {
    let now = 1000;
    const f = feed(() => now);
    await f.poll(async () => ({ agents: [agent("butchr-butchr-1", "working")] }));
    const first = f.snapshot();
    if (!first.checked) throw new Error("expected checked:true");
    expect(first.confirmedAt).toBe(new Date(1000).toISOString());
    expect(first.rows).toHaveLength(1);

    now = 2000;
    await f.poll(async () => ({ agents: [agent("butchr-butchr-1", "working")] }));
    const second = f.snapshot();
    if (!second.checked) throw new Error("expected checked:true");
    expect(second.confirmedAt).toBe(new Date(2000).toISOString());
    expect(second.confirmedAt).not.toBe(first.confirmedAt);
    expect(second.rows[0]!.confirmedAt).toBe(second.confirmedAt); // response-level and row-level agree
  });

  test("a failing poll yields checked:false with the PRIOR rows byte-identical (confirmedAt untouched), records a fresh declinedAt, and still rethrows", async () => {
    let now = 1000;
    const f = feed(() => now);
    await f.poll(async () => ({ agents: [agent("butchr-butchr-1", "working")] }));
    const beforeRows = f.snapshot().rows;

    now = 5000;
    const boom = new Error("agent.list: connection closed before a response");
    let caught: unknown;
    try {
      await f.poll(async () => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom); // the fetch failure propagates — never swallowed

    const after = f.snapshot();
    expect(after.checked).toBe(false);
    if (after.checked) throw new Error("expected checked:false");
    expect(after.declinedAt).toBe(new Date(5000).toISOString());
    expect(after.rows).toEqual(beforeRows); // NOT discarded (mutation 1's target)
    expect(after.rows[0]!.confirmedAt).toBe(new Date(1000).toISOString()); // NOT laundered to look fresh (mutation 2's target)
  });
});
