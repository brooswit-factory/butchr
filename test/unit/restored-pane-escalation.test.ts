import { describe, expect, test } from "bun:test";
import {
  createRestoredPaneEscalationDetector, RestoredPaneEscalationTracker, restoredPaneEscalationComment,
  RESTORED_PANE_ESCALATION_MARKER, RESTORED_PANE_ESCALATION_FIRST_MS, RESTORED_PANE_ESCALATION_REPEAT_MS,
} from "../../src/agents/restored-pane-escalation.js";

const MIN = 60_000;

/** A fake "own channel" comment store — same shape crash-loop.test.ts's fakeChannel uses. */
function fakeChannel() {
  const posted: { target: string; text: string }[] = [];
  return {
    posted,
    addComment: async (id: string, text: string) => { posted.push({ target: id, text }); },
  };
}

describe("RestoredPaneEscalationTracker: a standalone structure, never ResumeDeferGuard", () => {
  test("recordDeferral returns 0 on the first call, then ms elapsed since that first call on every later one", () => {
    const t = new RestoredPaneEscalationTracker();
    expect(t.recordDeferral("R", 1000)).toBe(0);
    expect(t.recordDeferral("R", 1000 + 5 * MIN)).toBe(5 * MIN);
    expect(t.recordDeferral("R", 1000 + 12 * MIN)).toBe(12 * MIN);
  });

  test("dueFor: false before the first threshold, true the instant it's crossed, false again until the repeat interval passes", () => {
    const t = new RestoredPaneEscalationTracker();
    expect(t.dueFor("R", 0, 9 * MIN, 10 * MIN, 60 * MIN)).toBe(false);
    expect(t.dueFor("R", 10 * MIN, 10 * MIN, 10 * MIN, 60 * MIN)).toBe(true);
    t.markEscalated("R", 10 * MIN);
    expect(t.dueFor("R", 10 * MIN + 1, 10 * MIN + 1, 10 * MIN, 60 * MIN)).toBe(false);
    expect(t.dueFor("R", 10 * MIN + 59 * MIN, 69 * MIN, 10 * MIN, 60 * MIN)).toBe(false);
    expect(t.dueFor("R", 10 * MIN + 60 * MIN, 70 * MIN, 10 * MIN, 60 * MIN)).toBe(true);
  });

  test("forgetMissing drops tracking for an id absent from the still-deferred set — a later deferral for the same id starts a fresh clock", () => {
    const t = new RestoredPaneEscalationTracker();
    t.recordDeferral("R", 0);
    t.markEscalated("R", 0);
    t.forgetMissing(new Set([])); // R resolved/no longer stale this poll
    // A brand-new streak for R starting at a later wall-clock instant reads as elapsed 0, not 999*MIN.
    expect(t.recordDeferral("R", 999 * MIN)).toBe(0);
  });

  test("forgetMissing leaves a still-deferred id's state untouched", () => {
    const t = new RestoredPaneEscalationTracker();
    t.recordDeferral("R", 0);
    t.forgetMissing(new Set(["R"]));
    expect(t.recordDeferral("R", 5 * MIN)).toBe(5 * MIN); // clock kept running
  });
});

describe("restoredPaneEscalationComment: distinctness from every other notice", () => {
  test("names the agent, elapsed time, degraded-without-flags, and that nothing was discarded", () => {
    const text = restoredPaneEscalationComment("buddy", 11 * MIN, "2026-09-29T00:11:00.000Z");
    expect(text).toContain("buddy");
    expect(text).toContain("11 minute");
    expect(text).toContain("DEGRADED");
    expect(text).toContain("has NOT been discarded");
    expect(text.startsWith(RESTORED_PANE_ESCALATION_MARKER)).toBe(true);
  });

  test("marker is distinct from every existing loss/notice marker", () => {
    expect(RESTORED_PANE_ESCALATION_MARKER).not.toBe("[butchr:respawn]");
    expect(RESTORED_PANE_ESCALATION_MARKER).not.toBe("[butchr:resume]");
  });

  test("text never contains a 'session lost: ...' substring, and never matches the model/effort onResumeWaiting wording", () => {
    const text = restoredPaneEscalationComment("R", 11 * MIN, "2026-09-29T00:11:00.000Z");
    expect(text).not.toContain("session lost:");
    expect(text).not.toContain("A model/effort change for");
  });

  test("rounds elapsed minutes to at least 1, never '0 minute(s)'", () => {
    const text = restoredPaneEscalationComment("R", 100, "2026-09-29T00:00:00.100Z");
    expect(text).toContain("~1 minute(s)");
  });
});

describe("createRestoredPaneEscalationDetector: the threshold itself", () => {
  test("negative case: an issue that resolves before the first threshold never escalates", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createRestoredPaneEscalationDetector({ now: () => now, addComment: chan.addComment, firstThresholdMs: 10 * MIN, repeatIntervalMs: 60 * MIN });
    for (let i = 0; i < 9; i++) { now = i * MIN; await det.check(["R"]); }
    now = 9 * MIN; await det.check([]); // resolved before crossing the threshold
    expect(chan.posted).toEqual([]);
  });

  test("first-notice, no-notice-in-between, repeat-notice: fires once at the first threshold, stays silent until the repeat interval, fires again after it", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createRestoredPaneEscalationDetector({ now: () => now, addComment: chan.addComment, firstThresholdMs: 10 * MIN, repeatIntervalMs: 60 * MIN });
    // Every minute for two hours, same issue stays deferred throughout.
    for (let m = 0; m <= 120; m++) {
      now = m * MIN;
      await det.check(["R"]);
    }
    // First notice at m=10, repeat at m=70 (10 + 60) — never in between, never a third within this span.
    expect(chan.posted.map((p) => p.target)).toEqual(["R", "R"]);
  });

  test("reset-on-no-longer-deferred: an id absent from `deferred` this poll has its streak cleared — a later re-deferral starts counting from zero again", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createRestoredPaneEscalationDetector({ now: () => now, addComment: chan.addComment, firstThresholdMs: 10 * MIN, repeatIntervalMs: 60 * MIN });
    for (let m = 0; m <= 9; m++) { now = m * MIN; await det.check(["R"]); } // 9 minutes in, well under threshold
    expect(chan.posted).toEqual([]);
    now = 9 * MIN + 1; await det.check([]); // resolved: no longer in the deferred set
    // A fresh streak starting way later must wait its OWN 10 minutes, not inherit the old clock.
    now = 100 * MIN; await det.check(["R"]);
    expect(chan.posted).toEqual([]);
    now = 100 * MIN + 10 * MIN; await det.check(["R"]);
    expect(chan.posted).toHaveLength(1);
  });

  test("two independent ids escalate independently, on their own clocks", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createRestoredPaneEscalationDetector({ now: () => now, addComment: chan.addComment, firstThresholdMs: 10 * MIN, repeatIntervalMs: 60 * MIN });
    await det.check(["A"]); // A starts at t=0
    now = 5 * MIN;
    await det.check(["A", "B"]); // B starts at t=5min
    now = 10 * MIN;
    await det.check(["A", "B"]); // A crosses 10min, B has only been deferred 5min
    expect(chan.posted.map((p) => p.target)).toEqual(["A"]);
    now = 15 * MIN;
    await det.check(["A", "B"]); // B now crosses its own 10min mark
    expect(chan.posted.map((p) => p.target)).toEqual(["A", "B"]);
  });

  test("defaults (no firstThresholdMs/repeatIntervalMs given) are the exported constants", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createRestoredPaneEscalationDetector({ now: () => now, addComment: chan.addComment });
    await det.check(["R"]); // establishes the streak's start at now=0
    now = RESTORED_PANE_ESCALATION_FIRST_MS - 1;
    await det.check(["R"]);
    expect(chan.posted).toEqual([]);
    now = RESTORED_PANE_ESCALATION_FIRST_MS;
    await det.check(["R"]);
    expect(chan.posted).toHaveLength(1);
    now += RESTORED_PANE_ESCALATION_REPEAT_MS - 1;
    await det.check(["R"]);
    expect(chan.posted).toHaveLength(1); // still not due
    now += 1;
    await det.check(["R"]);
    expect(chan.posted).toHaveLength(2);
  });

  test("an addComment rejection is logged, not thrown, and does not crash the poll", async () => {
    let now = 0;
    const logs: string[] = [];
    const det = createRestoredPaneEscalationDetector({
      now: () => now,
      addComment: async () => { throw new Error("jira down"); },
      log: (l) => logs.push(l),
      firstThresholdMs: 10 * MIN,
      repeatIntervalMs: 60 * MIN,
    });
    await det.check(["R"]); // establishes the streak's start at now=0
    now = 10 * MIN;
    await expect(det.check(["R"])).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("WARNING") && l.includes("R"))).toBe(true);
  });
});
