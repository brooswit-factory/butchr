import { describe, expect, test } from "bun:test";
import { StatusFloorTracker, humanDuration } from "../../src/agents/status-floor.js";

const MIN = 60_000;

describe("StatusFloorTracker: the fresh/unseen case is distinct from a genuine zero (BUTCHR-269)", () => {
  test("a first-ever observe() starts an INEXACT floor at `now`, not an exact one", () => {
    let now = 1000;
    const t = new StatusFloorTracker(() => now);
    const floor = t.observe("BUTCHR-1", "idle");
    expect(floor.exact).toBe(false);
    expect(floor.sinceMs).toBe(1000);
    expect(floor.since).toBe(new Date(1000).toISOString());
  });

  test("a fresh (inexact) floor can read numerically identical to a genuine exact one — `exact` is the field a caller must check, never the number alone", () => {
    let now = 5000;
    const fresh = new StatusFloorTracker(() => now);
    const freshFloor = fresh.observe("BUTCHR-1", "idle"); // first-ever observation: inexact, sinceMs === now

    const t2 = new StatusFloorTracker(() => now);
    t2.observe("BUTCHR-1", "working"); // first observation, at the same `now` — also inexact
    const exactFloor = t2.observe("BUTCHR-1", "idle"); // a genuine transition witnessed at the SAME `now` — exact

    expect(freshFloor.sinceMs).toBe(exactFloor.sinceMs); // numerically identical...
    expect(freshFloor.exact).toBe(false);
    expect(exactFloor.exact).toBe(true); // ...but not the same claim
  });
});

describe("StatusFloorTracker: a genuine, personally-observed transition resets the floor AND becomes exact (BUTCHR-269)", () => {
  test("a status change resets sinceMs to the transition time and marks exact:true", () => {
    let now = 0;
    const t = new StatusFloorTracker(() => now);
    t.observe("BUTCHR-1", "idle"); // inexact, floor at 0
    now = 5 * MIN;
    const changed = t.observe("BUTCHR-1", "working"); // real transition this tracker witnessed
    expect(changed.exact).toBe(true);
    expect(changed.sinceMs).toBe(5 * MIN);
  });

  test("a status that HOLDS across polls does not move sinceMs or exactness — only humanDuration grows", () => {
    let now = 0;
    const t = new StatusFloorTracker(() => now);
    const first = t.observe("BUTCHR-1", "idle");
    expect(first.exact).toBe(false);
    now = 3 * MIN;
    const held = t.observe("BUTCHR-1", "idle"); // same status again
    expect(held.sinceMs).toBe(first.sinceMs); // unchanged
    expect(held.exact).toBe(first.exact); // unchanged (still inexact — the original observation was never exact)
    expect(held.humanDuration).toBe("3m");
  });

  test("a real transition followed by holding keeps the exact floor pinned to the transition, not creeping forward", () => {
    let now = 0;
    const t = new StatusFloorTracker(() => now);
    t.observe("BUTCHR-1", "idle");
    now = 2 * MIN;
    const transitioned = t.observe("BUTCHR-1", "working"); // exact, floor at 2min
    now = 10 * MIN;
    const held = t.observe("BUTCHR-1", "working"); // still working
    expect(held.exact).toBe(true);
    expect(held.sinceMs).toBe(transitioned.sinceMs);
    expect(held.humanDuration).toBe("8m"); // 10min - 2min, not 10min
  });
});

describe("StatusFloorTracker.forgetMissing: an id that disappears starts a FRESH (inexact) floor on reappearance (BUTCHR-269)", () => {
  test("forgetting drops the old exact floor; a later re-observe is inexact again, not inheriting the old sinceMs", () => {
    let now = 0;
    const t = new StatusFloorTracker(() => now);
    t.observe("BUTCHR-1", "idle");
    now = 5 * MIN;
    const exact = t.observe("BUTCHR-1", "working");
    expect(exact.exact).toBe(true);

    t.forgetMissing(new Set()); // BUTCHR-1 absent from this poll's set

    now = 20 * MIN;
    const reappeared = t.observe("BUTCHR-1", "working"); // same status value as before forgetting, but a NEW episode
    expect(reappeared.exact).toBe(false); // inexact — this tracker has no basis to claim it knows when this started
    expect(reappeared.sinceMs).toBe(20 * MIN); // not the old 5min
  });

  test("an id still present in forgetMissing's set is untouched", () => {
    let now = 0;
    const t = new StatusFloorTracker(() => now);
    t.observe("BUTCHR-1", "idle");
    now = 5 * MIN;
    const before = t.observe("BUTCHR-1", "working");
    t.forgetMissing(new Set(["BUTCHR-1"]));
    now = 6 * MIN;
    const after = t.observe("BUTCHR-1", "working");
    expect(after.sinceMs).toBe(before.sinceMs);
    expect(after.exact).toBe(true);
  });
});

describe("humanDuration: a glanceable rendering, never a bare number (BUTCHR-269)", () => {
  test("sub-minute renders as seconds only", () => {
    expect(humanDuration(0)).toBe("0s");
    expect(humanDuration(42_000)).toBe("42s");
  });

  test("minutes-scale renders minutes and seconds are dropped once minutes appear... days/hours appear only once crossed", () => {
    expect(humanDuration(3 * 60_000 + 5_000)).toBe("3m");
    expect(humanDuration(62 * 60_000)).toBe("1h 2m");
  });

  test("multi-day durations are unmissable at a glance — the whole point of this field", () => {
    expect(humanDuration(6 * 86_400_000 + 3 * 3_600_000 + 12 * 60_000)).toBe("6d 3h 12m");
  });

  test("negative input (a misconfigured clock) never renders a negative duration", () => {
    expect(humanDuration(-500)).toBe("0s");
  });
});
