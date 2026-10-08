import { describe, expect, test } from "bun:test";
import { SilentStopTracker, createSilentStopCheck } from "../../src/agents/silent-stop.js";

describe("SilentStopTracker", () => {
  test("working -> idle reports the stop exactly once; the episode's working observation never reports", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    expect(t.observe("K-1", "working")).toBeNull();
    now = 60_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 0 });
    now = 75_000;
    expect(t.observe("K-1", "idle")).toBeNull(); // dedup: still the same stopped episode
    now = 90_000;
    expect(t.observe("K-1", "idle")).toBeNull();
  });

  test("working -> none reports a stop too (the session is simply gone)", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    t.observe("K-1", "working");
    now = 30_000;
    expect(t.observe("K-1", "none")).toEqual({ episodeStart: 0 });
    now = 45_000;
    expect(t.observe("K-1", "none")).toBeNull(); // dedup
  });

  test("blocked counts as active: working -> blocked -> working never reports a stop", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    t.observe("K-1", "working");
    now = 10_000;
    expect(t.observe("K-1", "blocked")).toBeNull();
    now = 20_000;
    expect(t.observe("K-1", "working")).toBeNull();
  });

  test("blocked counts as active: a working -> blocked -> idle run's episode starts from when WORKING began, not from when blocked ended", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    t.observe("K-1", "working"); // episode starts at 0
    now = 10_000;
    t.observe("K-1", "blocked"); // still the same episode
    now = 20_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 0 });
  });

  test("resuming after a reported stop starts a fresh episode, and a later stop reports again", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    t.observe("K-1", "working");
    now = 10_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 0 });
    now = 15_000;
    expect(t.observe("K-1", "idle")).toBeNull(); // dedup
    now = 20_000;
    t.observe("K-1", "working"); // resumes: fresh episode starts at 20_000
    now = 50_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 20_000 }); // reports again, anchored to the resume
  });

  test("a ticket only ever observed idle/none never reports a stop (it was never active)", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    expect(t.observe("K-1", "idle")).toBeNull();
    now = 60_000;
    expect(t.observe("K-1", "none")).toBeNull();
  });

  test("forget drops tracking so a later respawn starts a fresh episode", () => {
    let now = 0;
    const t = new SilentStopTracker(() => now);
    t.observe("K-1", "working");
    now = 10_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 0 });
    t.forget("K-1");
    now = 20_000;
    t.observe("K-1", "working"); // fresh entry, fresh episode at 20_000
    now = 30_000;
    expect(t.observe("K-1", "idle")).toEqual({ episodeStart: 20_000 });
  });
});

describe("createSilentStopCheck", () => {
  const comment = (id: string, body: string, created: string) => ({ id, body, created });

  // Every fixture below constructs at `now = 0` (the "daemon start" instant —
  // see src/agents/silent-stop.ts's own top comment) and then jumps `now`
  // PAST the 5-minute suppression window before driving any real scenario,
  // so the daemon-start grace period itself (covered separately below)
  // never contaminates an otherwise-unrelated test.
  const PAST_STARTUP = 10 * 60_000;

  test("DoD 1: a stop with no self-tagged comment produces exactly one `[silent-stop] would flag KEY` line", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[silent-stop] would flag K-1");
  });

  test("DoD 1: a stop preceded by this ticket's own tagged comment produces no line", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [comment("c1", "[K-1] finished up, see PR #4", new Date(now).toISOString())],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines).toHaveLength(0);
  });

  test("a comment tagged with a DIFFERENT key (a boss's tell_worker, or a peer's note) does NOT count as the worker having spoken", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [comment("c1", "[K-BOSS] go ahead and wrap up", new Date(now).toISOString())],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag K-1"))).toBe(true);
  });

  test("daemon chatter ([butchr:...]) does NOT count as the worker having spoken", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [comment("c1", "[butchr:respawn] relaunched", new Date(now).toISOString())],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag K-1"))).toBe(true);
  });

  test("a self-tagged comment landing BEFORE the current episode started does not count (it's old news)", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [comment("c1", "[K-1] previous report", new Date(PAST_STARTUP - 60_000).toISOString())],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working"); // episode starts at `now`
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag K-1"))).toBe(true);
  });

  test("DoD 2: dedup — a stop that stays idle across many polls logs only once", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    for (let i = 0; i < 5; i++) {
      now += 15_000;
      await check.check("K-1", "idle");
    }
    expect(lines.filter((l) => l.includes("would flag")).length).toBe(1);
  });

  test("an unparseable comment `created` field fails toward NOT flagging", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [comment("c1", "[K-1] report", "not-a-date")],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag"))).toBe(false);
  });

  test("a failed comments fetch never flags — a declined check is not a confirmed silence", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => { throw new Error("jira 503"); },
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag"))).toBe(false);
    expect(lines.some((l) => l.startsWith("WARNING:"))).toBe(true);
  });

  test("DoD 3: a stop within the suppression window of daemon start is suppressed, not flagged", async () => {
    let now = 0; // construction instant = daemon start, per this module's own top comment
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    await check.check("K-1", "working");
    now = 2 * 60_000; // 2 minutes after daemon start: inside the 5-minute window
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag"))).toBe(false);
    expect(lines.some((l) => l.includes("suppressed"))).toBe(true);
  });

  test("DoD 3: a stop AFTER the suppression window has elapsed since daemon start is evaluated normally", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    await check.check("K-1", "working");
    // Simulated continuous ~15s polling (no gap large enough to look like a
    // reconnect) all the way past the 5-minute suppression window, so this
    // test exercises "genuinely stayed up the whole time", not an artificial
    // gap this fixture itself introduced by skipping ticks.
    while (now < 6 * 60_000) {
      now += 15_000;
      await check.check("K-1", "working");
    }
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag K-1"))).toBe(true);
  });

  test("DoD 3: a gap in polling far larger than the daemon's own cadence (a herdr reconnect) re-arms the suppression window", async () => {
    let now = PAST_STARTUP; // well past daemon-start suppression already
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    await check.check("K-1", "working");
    now += 15_000; // one normal poll tick: no gap
    await check.check("K-1", "working");
    now += 5 * 60_000; // a 5-minute gap: far past DISCONTINUITY_GAP_MS — herdr was unreachable
    await check.check("K-1", "working"); // this poll is what notices the gap and re-arms the window
    now += 30_000; // 30s after the just-noticed reconnect: inside the fresh 5-minute window
    await check.check("K-1", "idle");
    expect(lines.some((l) => l.includes("would flag"))).toBe(false);
    expect(lines.some((l) => l.includes("suppressed"))).toBe(true);
  });

  test("suppression is per-check-instance global, not per-issue: a reconnect suppresses every ticket's next stop, not just the one that happened to notice the gap", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    await check.check("K-2", "working");
    now += 5 * 60_000; // gap
    await check.check("K-1", "working"); // notices the gap, re-arms
    await check.check("K-2", "working"); // same poll, same discontinuity instant
    now += 60_000; // inside the fresh window for both
    await check.check("K-1", "idle");
    await check.check("K-2", "idle");
    expect(lines.some((l) => l.includes("would flag"))).toBe(false);
    expect(lines.filter((l) => l.includes("suppressed")).length).toBe(2);
  });

  test("the pr-open context is included verbatim and never gates flag/no-flag", async () => {
    let now = 0;
    const lines: string[] = [];
    const check = createSilentStopCheck({
      now: () => now,
      suppressMinutes: 5,
      comments: async () => [],
      log: (l) => lines.push(l),
    });
    now = PAST_STARTUP;
    await check.check("K-1", "working");
    now += 60_000;
    await check.check("K-1", "idle", { prOpen: true });
    expect(lines[0]).toContain("pr open=yes");
  });
});
