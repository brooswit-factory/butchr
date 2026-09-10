import { describe, expect, test } from "bun:test";
import { StalledTracker, createStalledCheck } from "../../src/agents/stalled.js";

describe("StalledTracker", () => {
  test("candidate only after `minutes` of continuous idle since first observation", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    expect(t.observe("KAN-1", "idle")).toBe(false); // first observation: just started the floor
    now = 5 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false); // 5 min in: not yet
    now = 10 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(true); // 10 min in: candidate
    now = 20 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(true); // stays a candidate
  });

  // BUTCHR-279: re-anchored from "since first observed running" (a permanent
  // latch — the bug) to "since the agent LAST STOPPED WORKING". A `working`
  // observation still breaks the CURRENT streak — the guard survives — but it
  // now ARMS A FRESH FLOOR instead of permanently disqualifying the ticket, so
  // a later idle/done streak that holds for the full window still qualifies.
  test("a post-work stall qualifies once idle/done has held, uninterrupted, for the full window since work stopped", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    expect(t.observe("KAN-1", "working")).toBe(false);
    now = 3 * 60_000;
    expect(t.observe("KAN-1", "working")).toBe(false); // still working
    now = 5 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false); // just stopped working: floor starts here, not qualified yet
    now = 10 * 60_000; // 5 min of idle so far: not yet
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 15 * 60_000; // 10 min of idle since work stopped: qualifies
    expect(t.observe("KAN-1", "idle")).toBe(true);
    now = 60 * 60_000; // an hour later, still idle: stays a candidate
    expect(t.observe("KAN-1", "idle")).toBe(true);
  });

  test("a busy agent is never libelled stalled: an agent CURRENTLY working is never a candidate, no matter how long its history", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "idle");
    now = 15 * 60_000; // would already qualify if left idle
    expect(t.observe("KAN-1", "idle")).toBe(true);
    now = 16 * 60_000;
    expect(t.observe("KAN-1", "working")).toBe(false); // resumes working: never stalled while working
    now = 20 * 60_000;
    expect(t.observe("KAN-1", "working")).toBe(false);
  });

  test("a dip to idle between turns, followed by working again before the window elapses, never qualifies — the floor re-arms on every break, it does not accumulate across them", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "working");
    now = 1 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false); // floor starts
    now = 6 * 60_000; // 5 min idle: not yet (well under 10)
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 7 * 60_000;
    expect(t.observe("KAN-1", "working")).toBe(false); // back to work before the window elapsed: floor re-armed
    now = 15 * 60_000; // first idle observation after the break: this call itself starts the fresh floor at 15min
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 24 * 60_000; // 9 min since the fresh floor (15min): if the OLD floor (from 1min) had survived this would already have qualified
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 25 * 60_000; // 10 min since the fresh floor (15min)
    expect(t.observe("KAN-1", "idle")).toBe(true);
  });

  test("blocked also breaks the idle/done streak and re-arms the floor (it's not idle, and it's a distinct, already-visible condition)", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "idle");
    now = 15 * 60_000;
    expect(t.observe("KAN-1", "blocked")).toBe(false);
    now = 20 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false); // streak broken by the blocked observation: fresh floor at 20min
    now = 30 * 60_000; // 10 min since the re-armed floor
    expect(t.observe("KAN-1", "idle")).toBe(true);
  });

  test("none breaks the streak, re-arms the floor, and never itself qualifies — even sustained", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "working");
    now = 5 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 8 * 60_000;
    expect(t.observe("KAN-1", "none")).toBe(false); // agent disappeared: never a candidate
    now = 100 * 60_000; // sustained "none" for a long time
    expect(t.observe("KAN-1", "none")).toBe(false);
    now = 108 * 60_000; // re-attaches idle: floor starts fresh from here, not from before "none"
    expect(t.observe("KAN-1", "idle")).toBe(false);
    now = 118 * 60_000; // 10 min since the fresh floor
    expect(t.observe("KAN-1", "idle")).toBe(true);
  });

  test("forget() drops tracking so a later observation starts a fresh floor", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "idle");
    now = 15 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(true);
    t.forget("KAN-1");
    expect(t.observe("KAN-1", "idle")).toBe(false); // fresh floor at `now`, not yet 10 minutes
  });

  // BUTCHR-221/BUTCHR-210/BUTCHR-279: the genuine, measured
  // idle-since-work-stopped duration, exposed for the stall remediator's
  // wake comment (see src/agents/stall-remediation.ts) — a pure query,
  // distinct from observe's own boolean.
  describe("elapsedMinutes", () => {
    test("null when untracked (never observed)", () => {
      const t = new StalledTracker(() => 0, 10);
      expect(t.elapsedMinutes("KAN-1")).toBe(null);
    });

    test("grows with real elapsed time since the floor started", () => {
      let now = 0;
      const t = new StalledTracker(() => now, 10);
      t.observe("KAN-1", "idle");
      expect(t.elapsedMinutes("KAN-1")).toBe(0);
      now = 450 * 60_000;
      expect(t.elapsedMinutes("KAN-1")).toBe(450);
    });

    test("null while no streak is currently running — reset the instant a working/blocked/none observation breaks it, since there is no current floor to report", () => {
      let now = 0;
      const t = new StalledTracker(() => now, 10);
      t.observe("KAN-1", "idle");
      now = 5 * 60_000;
      expect(t.elapsedMinutes("KAN-1")).toBe(5);
      t.observe("KAN-1", "working");
      expect(t.elapsedMinutes("KAN-1")).toBe(null);
    });

    test("null again after forget", () => {
      let now = 0;
      const t = new StalledTracker(() => now, 10);
      t.observe("KAN-1", "idle");
      now = 5 * 60_000;
      t.forget("KAN-1");
      expect(t.elapsedMinutes("KAN-1")).toBe(null);
    });
  });
});

describe("createStalledCheck", () => {
  test("fetches comments only once the cheap preconditions hold, and stalled=true when none are from the account", async () => {
    let now = 0;
    const fetched: string[] = [];
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async (issue) => { fetched.push(issue); return []; },
      accountEmail: "daemon@example.com",
    });
    expect(await check.check("KAN-1", "idle")).toBe(false);
    expect(fetched).toEqual([]); // not yet a candidate — zero Jira cost
    now = 10 * 60_000;
    expect(await check.check("KAN-1", "idle")).toBe(true);
    expect(fetched).toEqual(["KAN-1"]); // exactly one fetch, only once it mattered
  });

  test("never stalled once the account has commented, even if it's the only comment on the ticket", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [{ authorEmail: "daemon@example.com" }],
      accountEmail: "daemon@example.com",
    });
    now = 10 * 60_000;
    expect(await check.check("KAN-1", "idle")).toBe(false);
  });

  test("a comment from someone else does not disqualify stalled — the AGENT never spoke", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [{ authorEmail: "a-human@example.com" }],
      accountEmail: "daemon@example.com",
    });
    await check.check("KAN-1", "idle"); // establishes the floor at now=0
    now = 10 * 60_000;
    expect(await check.check("KAN-1", "idle")).toBe(true);
  });

  // BUTCHR-279 FIRES case at the createStalledCheck level (one layer above
  // the bare tracker tested above): a worked-then-idle agent, idle/done
  // continuously for the full window with zero daemon comments, resolves
  // stalled=true — this is the defect this ticket fixes.
  test("a post-work stall becomes stalled=true once idle/done has held for the full window since work stopped", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [],
      accountEmail: "daemon@example.com",
    });
    await check.check("KAN-1", "working");
    now = 60 * 60_000; // an hour later, first idle observation: floor starts here, not yet qualified
    expect(await check.check("KAN-1", "idle")).toBe(false);
    now = 70 * 60_000; // 10 min of idle since work stopped
    expect(await check.check("KAN-1", "idle")).toBe(true);
  });

  test("an agent CURRENTLY working is never stalled, no matter how long its idle history", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [],
      accountEmail: "daemon@example.com",
    });
    await check.check("KAN-1", "idle");
    now = 15 * 60_000; // would already qualify if left idle
    expect(await check.check("KAN-1", "idle")).toBe(true);
    now = 16 * 60_000;
    expect(await check.check("KAN-1", "working")).toBe(false);
  });

  test("an agent that worked and then disappeared entirely (sustained none) is never stalled", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [],
      accountEmail: "daemon@example.com",
    });
    await check.check("KAN-1", "working");
    now = 5 * 60_000;
    await check.check("KAN-1", "none");
    now = 500 * 60_000; // sustained "none" for a long time
    expect(await check.check("KAN-1", "none")).toBe(false);
  });

  test("a failing comments fetch resolves null (could not verify) — a THIRD outcome, never a confident stalled=true", async () => {
    let now = 0;
    const logs: string[] = [];
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => { throw new Error("timeout"); },
      accountEmail: "daemon@example.com",
      log: (l) => logs.push(l),
    });
    await check.check("KAN-1", "idle"); // establishes the floor at now=0
    now = 10 * 60_000;
    expect(await check.check("KAN-1", "idle")).toBe(null); // could not verify — NOT treated as "no comments found"
    expect(logs.some((l) => l.includes("WARNING") && l.includes("KAN-1") && l.includes("timeout"))).toBe(true);
  });

  test("elapsedMinutes is exposed on the built StalledCheck, backed by the same tracker check() already advances", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [],
      accountEmail: "daemon@example.com",
    });
    expect(check.elapsedMinutes?.("KAN-1")).toBe(null); // never observed yet
    await check.check("KAN-1", "idle");
    now = 25 * 60_000;
    expect(check.elapsedMinutes?.("KAN-1")).toBe(25);
  });
});
