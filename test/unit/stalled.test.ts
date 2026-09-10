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

  test("never a candidate once the agent has been working, even long after — 'has been working' is permanent", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "idle");
    now = 3 * 60_000;
    expect(t.observe("KAN-1", "working")).toBe(false);
    now = 60 * 60_000; // an hour later, back to idle
    expect(t.observe("KAN-1", "idle")).toBe(false); // streak was broken; never a candidate again for this entry
  });

  test("blocked also breaks the idle/done streak (it's not idle, and it's a distinct, already-visible condition)", () => {
    let now = 0;
    const t = new StalledTracker(() => now, 10);
    t.observe("KAN-1", "idle");
    now = 15 * 60_000;
    expect(t.observe("KAN-1", "blocked")).toBe(false);
    now = 30 * 60_000;
    expect(t.observe("KAN-1", "idle")).toBe(false); // streak broken by the blocked observation
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

  // BUTCHR-221/BUTCHR-210: the genuine, measured idle-since-spawn duration,
  // exposed for the stall remediator's wake comment (see
  // src/agents/stall-remediation.ts) — a pure query, distinct from observe's
  // own boolean.
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

  test("never stalled once the agent has ever been working", async () => {
    let now = 0;
    const check = createStalledCheck({
      now: () => now,
      minutes: 10,
      comments: async () => [],
      accountEmail: "daemon@example.com",
    });
    await check.check("KAN-1", "working");
    now = 60 * 60_000;
    expect(await check.check("KAN-1", "idle")).toBe(false);
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
