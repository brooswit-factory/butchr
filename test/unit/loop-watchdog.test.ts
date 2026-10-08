import { describe, expect, test } from "bun:test";
import { createLoopWatchdog } from "../../src/daemon/loop-watchdog.js";
import { combineHealth, createLoopHealth, type ComponentHealth } from "../../src/daemon/health.js";
import { startLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";

const fakeHerd: Herd = {
  async runningIssues() { return []; },
  async staleIssues() { return []; },
  async spawn() {},
  async stop() {},
  async paneFor() { return null; },
  async nudge() { return { delivered: true }; },
  async resumeInPlace() { return "unresumable" as const; },
};

describe("loop-watchdog (FACTORY-772)", () => {
  // AC3: the regression stub's await NEVER settles (not a rejecting stub —
  // a rejecting stub would hit startLoop's onError seam and prove nothing
  // about the silent-death case this ticket exists for). This test is the
  // "fails without the watchdog" half of AC3: with no watchdog wired in at
  // all, a pollLoop wedged on a never-settling await stays stale forever —
  // nothing in loop.ts/health.ts on their own ever recovers it.
  test("regression: a pollLoop stuck on a never-settling await never recovers on its own", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 30, checkIntervalMs: 5 });
    const stop = startLoop({
      search: () => new Promise<never>(() => {}), // never resolves, never rejects
      herd: fakeHerd,
      notify: () => {},
      intervalMs: 10,
      onPollSuccess: () => health.recordSuccess(),
    });
    try {
      await Bun.sleep(80);
      const [component] = health.status().components;
      expect(component).toMatchObject({ name: "pollLoop", state: "stale" });
      // Waiting longer changes nothing — there is no mechanism here that
      // would ever flip this back to "ok" without outside intervention.
      await Bun.sleep(40);
      const [stillComponent] = health.status().components;
      expect(stillComponent).toMatchObject({ name: "pollLoop", state: "stale" });
    } finally {
      stop();
      health.stop();
    }
  });

  // The fix: the SAME never-settling stub, but now with createLoopWatchdog
  // wired in. `restart()` discards the wedged loop's Stop handle and starts
  // a fresh one with a search that actually resolves — the loop ticks again
  // and /health's pollLoop component recovers, with the restart itself
  // recorded (AC2).
  test("the watchdog restarts a wedged pollLoop, and it ticks again", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 30, checkIntervalMs: 5 });
    let stop = startLoop({
      search: () => new Promise<never>(() => {}),
      herd: fakeHerd,
      notify: () => {},
      intervalMs: 10,
      onPollSuccess: () => health.recordSuccess(),
    });
    const watchdog = createLoopWatchdog(
      [{
        names: ["pollLoop"],
        components: () => health.status().components,
        restart: () => {
          stop();
          stop = startLoop({
            search: async () => [],
            herd: fakeHerd,
            notify: () => {},
            intervalMs: 10,
            onPollSuccess: () => health.recordSuccess(),
          });
        },
      }],
      { thresholdMs: 30, checkIntervalMs: 5 },
    );
    try {
      await Bun.sleep(150);
      const [component] = health.status().components;
      expect(component).toMatchObject({ name: "pollLoop", ok: true, state: "ok" });
      const [report] = watchdog.reports();
      expect(report!.name).toBe("pollLoop");
      expect(report!.restartCount).toBeGreaterThanOrEqual(1);
      expect(report!.lastRestartAt).not.toBeNull();
    } finally {
      watchdog.stop();
      stop();
      health.stop();
    }
  });

  // AC2: /health must be able to show THAT a restart happened and WHEN, not
  // merely that the loop reads healthy again — combineHealth's new sibling.
  test("/health's loopWatchdog sibling round-trips restart history, additive only", () => {
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, checkIntervalMs: 1e9 });
    const report = [{ name: "pollLoop", restartCount: 2, lastRestartAt: new Date(500).toISOString() }];
    const withWatchdog = combineHealth([poll], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, report);
    expect(withWatchdog.loopWatchdog).toEqual(report);
    expect(withWatchdog.ok).toBe(poll.status().ok); // never flips `ok`
    expect("loopWatchdog" in combineHealth([poll])).toBe(false); // absent, never an empty array, when omitted
    poll.stop();
  });

  // AC4 (a): must NOT re-trip repeatedly on an already-stale entry. A
  // wedged loop's own heartbeat timestamp does not move just because the
  // watchdog restarted it — staleForMs keeps climbing from the OLD
  // lastSuccessAt until a fresh success lands. Re-tripping on every check
  // during that window is exactly FACTORY-746's sibling defect (a); this
  // asserts staleness is re-measured from the watchdog's OWN restart clock
  // instead.
  test("does not re-trip until a full threshold has passed since its own restart", async () => {
    let nowMs = 0;
    let staleForMs = 0;
    const restarts: number[] = [];
    const component = (): ComponentHealth => ({ name: "pollLoop", ok: false, state: "stale", lastSuccessAt: null, staleForMs });
    const watchdog = createLoopWatchdog(
      [{ names: ["pollLoop"], components: () => [component()], restart: () => { restarts.push(nowMs); } }],
      { thresholdMs: 100, checkIntervalMs: 5, now: () => nowMs },
    );
    try {
      nowMs = 150; staleForMs = 150;
      await Bun.sleep(40); // many checkIntervalMs(5) ticks while still stale
      expect(restarts).toEqual([150]); // tripped exactly once, not once per check

      // Still inside the 100ms cooldown since the restart at 150 (now 200,
      // only 50ms later) — must not trip again even though staleForMs (the
      // OLD, unmoved heartbeat) still reads well past threshold.
      nowMs = 200; staleForMs = 200;
      await Bun.sleep(20);
      expect(restarts).toEqual([150]);

      // Past the cooldown (260 - 150 = 110 >= 100) and genuinely still
      // stale (simulating the replacement loop also never ticking) — a
      // real, distinct failure is allowed to trip again.
      nowMs = 260; staleForMs = 260;
      await Bun.sleep(20);
      expect(restarts).toEqual([150, 260]);
    } finally {
      watchdog.stop();
    }
  });

  // AC4 (b): a forced reset needs a generation/epoch guard so a late-
  // settling stale tick's own completion can never clear in-flight state
  // out from under a newer one — asserted here as OBSERVED CONCURRENCY
  // (a live counter, incremented on entry and decremented on exit), not
  // merely call counts, exactly as the ticket requires: call counts alone
  // cannot distinguish "restarted twice, sequentially" from "two restarts
  // running at once".
  test("a slow restart is never invoked concurrently with itself", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const alwaysStale: ComponentHealth = { name: "notify", ok: false, state: "stale", lastSuccessAt: null, staleForMs: 10_000 };
    const watchdog = createLoopWatchdog(
      [{
        names: ["notify"],
        components: () => [alwaysStale],
        restart: async () => {
          calls++;
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await Bun.sleep(30);
          concurrent--;
        },
      }],
      { thresholdMs: 10, checkIntervalMs: 2 },
    );
    await Bun.sleep(100);
    watchdog.stop();
    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("one restart can cover more than one reported name (pollLoop and notify share one underlying loop)", async () => {
    let restarts = 0;
    // Mirrors production: a restart replaces the underlying loop, so the
    // liveness component it reports goes back to healthy. Without this, the
    // stub stays permanently stale and the watchdog's re-trip cooldown
    // (correctly) keeps tripping it again once the cooldown elapses — that
    // repeat-trip behavior has its own dedicated test above; this test is
    // only about one restart covering two names, so the stub must recover.
    const stale: ComponentHealth = { name: "either", ok: false, state: "stale", lastSuccessAt: null, staleForMs: 10_000 };
    const healthy: ComponentHealth = { name: "either", ok: true, state: "ok", lastSuccessAt: new Date().toISOString(), staleForMs: 0 };
    let recovered = false;
    const watchdog = createLoopWatchdog(
      [{ names: ["pollLoop", "notify"], components: () => [recovered ? healthy : stale], restart: () => { restarts++; recovered = true; } }],
      { thresholdMs: 10, checkIntervalMs: 5 },
    );
    await Bun.sleep(30);
    watchdog.stop();
    expect(restarts).toBe(1);
    const reports = watchdog.reports();
    expect(reports.map((r) => r.name).sort()).toEqual(["notify", "pollLoop"]);
    expect(reports.every((r) => r.restartCount === 1)).toBe(true);
    expect(reports[0]!.lastRestartAt).toEqual(reports[1]!.lastRestartAt);
  });
});
