import { describe, expect, test } from "bun:test";
import { createCoverageTracker } from "../../src/daemon/coverage.js";

describe("createCoverageTracker", () => {
  test("starts empty — no entries until something is recorded", () => {
    const t = createCoverageTracker(() => 0);
    expect(t.snapshot()).toEqual([]);
  });

  test("recordChecked increments checkedCount only, never declinedCount or lastDeclinedAt", () => {
    const t = createCoverageTracker(() => 1000);
    t.recordChecked("stalled");
    t.recordChecked("stalled");
    expect(t.snapshot()).toEqual([{ name: "stalled", checkedCount: 2, declinedCount: 0, lastDeclinedAt: null }]);
  });

  test("recordDeclined increments declinedCount and stamps lastDeclinedAt, never checkedCount", () => {
    const t = createCoverageTracker(() => 5000);
    t.recordDeclined("parked");
    expect(t.snapshot()).toEqual([{ name: "parked", checkedCount: 0, declinedCount: 1, lastDeclinedAt: new Date(5000).toISOString() }]);
  });

  test("lastDeclinedAt tracks the MOST RECENT decline, not the first", () => {
    let now = 1000;
    const t = createCoverageTracker(() => now);
    t.recordDeclined("stalled");
    now = 9000;
    t.recordDeclined("stalled");
    expect(t.snapshot()[0]!.lastDeclinedAt).toBe(new Date(9000).toISOString());
    expect(t.snapshot()[0]!.declinedCount).toBe(2);
  });

  test("distinct names are tracked independently — a decline on one name never touches another's counters", () => {
    const t = createCoverageTracker(() => 42);
    t.recordChecked("stalled");
    t.recordChecked("stalled");
    t.recordDeclined("parked");
    const snap = t.snapshot();
    const byName = Object.fromEntries(snap.map((e) => [e.name, e]));
    expect(byName["stalled"]).toEqual({ name: "stalled", checkedCount: 2, declinedCount: 0, lastDeclinedAt: null });
    expect(byName["parked"]).toEqual({ name: "parked", checkedCount: 0, declinedCount: 1, lastDeclinedAt: new Date(42).toISOString() });
  });

  test("a name can be both checked and declined over its lifetime — a poll's clean run does not erase yesterday's decline", () => {
    const t = createCoverageTracker(() => 100);
    t.recordDeclined("stalled");
    t.recordChecked("stalled");
    t.recordChecked("stalled");
    expect(t.snapshot()).toEqual([{ name: "stalled", checkedCount: 2, declinedCount: 1, lastDeclinedAt: new Date(100).toISOString() }]);
  });

  // PR #228 review: snapshot()'s doc comment used to claim "most-recently-
  // declined first" — the implementation (a Map, insertion order) never did
  // that. Pins the CORRECTED claim (plain first-seen order, independent of
  // who declined or when) so the doc comment can't drift from the
  // implementation again without this test catching it.
  test("snapshot() returns names in first-seen (insertion) order, regardless of which ones later decline or when", () => {
    let now = 1000;
    const t = createCoverageTracker(() => now);
    t.recordChecked("alpha"); // first-seen, never declines
    now = 2000;
    t.recordDeclined("beta"); // second-seen, declines early
    now = 3000;
    t.recordDeclined("gamma"); // third-seen, declines LATEST — would sort first under the old (wrong) doc claim
    expect(t.snapshot().map((e) => e.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});
