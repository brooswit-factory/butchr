import { describe, expect, test } from "bun:test";
import { buildDashboardRows, createDashboardFeed, initialDashboardSnapshot, type AgentDashboardRow, type DashboardAgent, type DashboardRow, type IssueMeta } from "../../src/agents/dashboard.js";
import { createAdmissionController } from "../../src/agents/admission.js";
import { StatusFloorTracker } from "../../src/agents/status-floor.js";

function agent(name: string, status = "idle", pane = "p1"): DashboardAgent {
  return { name, agent_status: status, pane_id: pane };
}

/** `buildDashboardRows` only ever produces "agent" rows — this narrows for the tests below rather than repeating the same `if (kind !== "agent") throw` at every call site. */
function asAgentRow(row: DashboardRow): AgentDashboardRow {
  if (row.kind !== "agent") throw new Error("expected an agent row");
  return row;
}

/** An admission controller with no declared sources and a residency read that never withholds anything — stands in wherever a test only cares about `createDashboardFeed`'s agent-row behaviour and needs a harmless `admission` dep. */
function noWithholding() {
  return createAdmissionController({ cap: 1_000_000, residency: async () => [] });
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
    const row = asAgentRow(rows[0]!);
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
    const exact = asAgentRow(buildDashboardRows([agent("butchr-butchr-1", "idle")], { now: () => now, issueMeta: () => undefined, tracker })[0]!);
    expect(exact.timeInStatus.exact).toBe(true); // real transition, witnessed

    now = 10 * 60_000;
    buildDashboardRows([], { now: () => now, issueMeta: () => undefined, tracker }); // BUTCHR-1 absent this poll

    now = 20 * 60_000;
    const reappeared = asAgentRow(buildDashboardRows([agent("butchr-butchr-1", "idle")], { now: () => now, issueMeta: () => undefined, tracker })[0]!);
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
    const admission = noWithholding();
    return createDashboardFeed({ now, issueMeta: () => undefined, tracker: new StatusFloorTracker(now), withheldTracker: new StatusFloorTracker(now), admission: () => admission.census() });
  }

  test("before any poll, the snapshot is checked:false with no rows — 'could not check', never 'fleet empty'", () => {
    const f = feed(() => 0);
    expect(f.snapshot()).toEqual(initialDashboardSnapshot(() => 0, noWithholding().census()));
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

// BUTCHR-332: one row per admission-withheld ticket, per-source, driven
// through the REAL `createAdmissionController` and `createDashboardFeed` —
// never a hand-assembled `AdmissionCensus` (the ticket's own review-bar
// rule 3). Each test below names the specific mutation on the ticket's
// review-bar list it pins.
describe("createDashboardFeed + createAdmissionController: per-source withheld rows (BUTCHR-332)", () => {
  test("a withheld row is present while withheld, carries its source and a not-applicable agentFields marker, and disappears (becomes an agent row) once admitted", async () => {
    let now = 0;
    const depsObj = { cap: 1, residency: async () => [] as readonly string[], sources: ["issue"], now: () => now };
    const admission = createAdmissionController(depsObj);
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });

    await admission.admit(["A", "B"], [], "issue"); // cap 1 — A admitted, B withheld
    await feed.poll(async () => ({ agents: [agent("butchr-a")] }));
    let snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    expect(snap.rows.find((r) => r.resourceKey === "A")?.kind).toBe("agent");
    const withheldRow = snap.rows.find((r) => r.resourceKey === "B");
    if (!withheldRow || withheldRow.kind !== "withheld") throw new Error("expected a withheld row for B");
    expect(withheldRow.source).toBe("issue");
    // mutation 1's own target: not-applicable (agentFields), never could-not-check (checked/declinedAt).
    expect(withheldRow.agentFields).toEqual({ applicable: false, reason: "no agent: withheld by the admission cap" });
    expect("checked" in withheldRow.agentFields).toBe(false);
    expect("pane" in withheldRow).toBe(false);
    expect("agentStatus" in withheldRow).toBe(false);

    // mutation 8's own target: once admitted, the withheld row must not survive.
    depsObj.cap = 2; // free a slot
    now = 1000;
    await admission.admit(["A", "B"], [], "issue"); // both admitted now
    await feed.poll(async () => ({ agents: [agent("butchr-a"), agent("butchr-b")] }));
    snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    expect(snap.rows.find((r) => r.resourceKey === "B")?.kind).toBe("agent");
    expect(snap.rows.some((r) => r.kind === "withheld")).toBe(false);
  });

  test("agent wins even over a row CARRIED FORWARD from a declined source: a stale withheld row for a key that now has a live agent is dropped, not shown twice", async () => {
    let now = 0;
    let issueBroken = false;
    const admission = createAdmissionController({
      cap: 0,
      residency: async () => { if (issueBroken) throw new Error("herdr down"); return []; },
      sources: ["issue"],
      now: () => now,
    });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });

    await admission.admit(["A"], [], "issue"); // A withheld
    await feed.poll(async () => ({ agents: [] }));
    let snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    expect(snap.rows.find((r) => r.resourceKey === "A")?.kind).toBe("withheld");

    // The issue tier's own census now fails — its bucket declines, so A's
    // stale withheld row would ordinarily carry forward untouched. But A
    // ALSO now has a live agent (this daemon's own agent.list(), independent
    // of the admission census) — the agent wins regardless of which poll
    // last refreshed A's own source.
    issueBroken = true;
    now = 5000;
    await admission.admit(["A"], [], "issue"); // declines — A's carried-forward row would otherwise persist
    await feed.poll(async () => ({ agents: [agent("butchr-a")] }));
    snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    expect(snap.rows.find((r) => r.resourceKey === "A")?.kind).toBe("agent");
    expect(snap.rows.some((r) => r.kind === "withheld")).toBe(false);
  });

  test("mutations 2/3/4: a failed census in ONE source carries that source's prior rows forward could-not-check, without inventing new ones, and never touches a DIFFERENT source's rows or census", async () => {
    let now = 0;
    let issueBroken = false;
    const admission = createAdmissionController({
      cap: 0, // saturated — anything named is withheld, isolating this test from admission arithmetic
      residency: async () => { if (issueBroken) throw new Error("herdr down"); return []; },
      sources: ["issue", "project"],
      now: () => now,
    });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });

    await admission.admit(["I1"], [], "issue");
    await admission.admit(["P1"], [], "project");
    await feed.poll(async () => ({ agents: [] }));
    let snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    expect(snap.rows.map((r) => r.resourceKey).sort()).toEqual(["I1", "P1"]);

    issueBroken = true;
    now = 5000;
    await admission.admit(["I1"], [], "issue"); // fail-safe — withholds nothing NEW, records a decline
    await feed.poll(async () => ({ agents: [] }));
    snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");

    const issueView = snap.admission.sources.find((s) => s.source === "issue")!;
    const projectView = snap.admission.sources.find((s) => s.source === "project")!;
    // mutation 3's own target: a failed census reads could-not-check, never checked:true.
    expect(issueView.census.checked).toBe(false);
    if (issueView.census.checked) throw new Error("expected checked:false");
    expect(issueView.census.reason).toBe("census-threw");
    // mutation 4's own target: the OTHER source is completely unaffected.
    expect(projectView.census).toEqual({ checked: true, confirmedAt: new Date(0).toISOString() });
    const projectRow = snap.rows.find((r) => r.resourceKey === "P1");
    if (!projectRow || projectRow.kind !== "withheld") throw new Error("expected P1's row to survive, untouched");
    expect(projectRow.confirmedAt).toBe(new Date(0).toISOString());
    // mutation 2's own target: the DECLINED source's own PRIOR row carries
    // forward byte-identical — never invented fresh, never dropped.
    const issueRow = snap.rows.find((r) => r.resourceKey === "I1");
    if (!issueRow || issueRow.kind !== "withheld") throw new Error("expected I1's withheld row to survive the decline");
    expect(issueRow.confirmedAt).toBe(new Date(0).toISOString()); // NOT re-stamped to 5000
  });

  test("mutations 5/11/12: a source that has never reported renders could-not-check, not 'nothing withheld' — even while a sibling source is fully healthy, and before any poll at all", async () => {
    const admission = createAdmissionController({ cap: 5, residency: async () => [], sources: ["issue", "project"], now: () => 0 });
    // Before any poll: every declared source is could-not-check, never a
    // vacuous "checked, nothing withheld" (mutation 11).
    const beforeAnyPoll = initialDashboardSnapshot(() => 0, admission.census());
    expect(beforeAnyPoll.admission.sources).toHaveLength(2);
    for (const s of beforeAnyPoll.admission.sources) {
      expect(s.census.checked).toBe(false);
      if (s.census.checked) throw new Error("expected checked:false");
      expect(s.census.reason).toBe("never-reported");
    }

    // Only the issue tier has ever polled — project has never called admit() at all (mutation 12).
    const feed = createDashboardFeed({
      now: () => 0,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => 0),
      withheldTracker: new StatusFloorTracker(() => 0),
      admission: () => admission.census(),
    });
    await admission.admit(["I1"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));
    const snap = feed.snapshot();
    if (!snap.checked) throw new Error("expected checked:true");
    const projectView = snap.admission.sources.find((s) => s.source === "project")!;
    expect(projectView.census.checked).toBe(false);
    if (projectView.census.checked) throw new Error("expected checked:false");
    expect(projectView.census.reason).toBe("never-reported");
    const issueView = snap.admission.sources.find((s) => s.source === "issue")!;
    expect(issueView.census.checked).toBe(true); // the reporting source is unaffected by its silent sibling
  });

  test("mutation 6: a withheld row's confirmedAt is not re-stamped by repeated snapshot() reads", async () => {
    let now = 1000;
    const admission = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"], now: () => now });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });
    await admission.admit(["A"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));

    now = 9000; // the clock moves between reads — only a POLL that observed it may advance confirmedAt
    const first = feed.snapshot();
    const second = feed.snapshot();
    expect(second).toEqual(first);
    if (!first.checked) throw new Error("expected checked:true");
    const row = first.rows.find((r) => r.resourceKey === "A");
    if (!row || row.kind !== "withheld") throw new Error("expected a withheld row");
    expect(row.confirmedAt).toBe(new Date(1000).toISOString());
  });

  test("mutation 7: a withheld row's confirmedAt is not re-stamped by a poll whose OWN source declined — the clock genuinely moves, so a frozen-clock assertion could not pass for the wrong reason", async () => {
    let now = 1000;
    let broken = false;
    const admission = createAdmissionController({
      cap: 0,
      residency: async () => { if (broken) throw new Error("down"); return []; },
      sources: ["issue"],
      now: () => now,
    });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => admission.census(),
    });
    await admission.admit(["A"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));
    const firstRow = feed.snapshot().rows.find((r) => r.resourceKey === "A");
    if (!firstRow || firstRow.kind !== "withheld") throw new Error("expected a withheld row");
    expect(firstRow.confirmedAt).toBe(new Date(1000).toISOString());

    broken = true;
    now = 9000; // the clock genuinely advances
    await admission.admit(["A"], [], "issue"); // fail-safe — declines, never throws itself
    await feed.poll(async () => ({ agents: [] }));
    const secondRow = feed.snapshot().rows.find((r) => r.resourceKey === "A");
    if (!secondRow || secondRow.kind !== "withheld") throw new Error("expected the withheld row to survive the decline");
    expect(secondRow.confirmedAt).toBe(new Date(1000).toISOString()); // NOT advanced to 9000
  });

  test("the request handler does no I/O: repeated snapshot() reads never call the admission census accessor again", async () => {
    let now = 0;
    let admissionCalls = 0;
    const admission = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue"], now: () => now });
    const feed = createDashboardFeed({
      now: () => now,
      issueMeta: () => undefined,
      tracker: new StatusFloorTracker(() => now),
      withheldTracker: new StatusFloorTracker(() => now),
      admission: () => { admissionCalls++; return admission.census(); },
    });
    await admission.admit(["A"], [], "issue");
    await feed.poll(async () => ({ agents: [] }));
    const callsAfterPoll = admissionCalls;
    feed.snapshot();
    feed.snapshot();
    feed.snapshot();
    expect(admissionCalls).toBe(callsAfterPoll); // snapshot() itself never touches admission()
  });
});
