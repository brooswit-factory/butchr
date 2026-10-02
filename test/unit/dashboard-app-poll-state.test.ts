import { describe, expect, test } from "bun:test";
import { initialPollState, nextBackoffMs, reducePollState } from "../../dashboard-app/src/view-model/poll-state.js";

describe("reducePollState (pure) — FACTORY-614", () => {
  test("loading -> loaded on the first success", () => {
    const next = reducePollState(initialPollState, { type: "success", data: { n: 1 }, now: 100 });
    expect(next).toEqual({ kind: "loaded", data: { n: 1 }, confirmedAt: 100 });
  });

  test("loading -> error on a failure with no prior data (nothing to show stale)", () => {
    const next = reducePollState(initialPollState, { type: "failure", error: "boom" });
    expect(next).toEqual({ kind: "error", error: "boom" });
  });

  test("a refresh failure after a success keeps the LAST GOOD data and age, marked stale with the new error — never discards or re-stamps it", () => {
    const loaded = reducePollState(initialPollState, { type: "success", data: { n: 1 }, now: 100 });
    const stale = reducePollState(loaded, { type: "failure", error: "network down" });
    expect(stale).toEqual({ kind: "stale", data: { n: 1 }, confirmedAt: 100, error: "network down" });
  });

  test("repeated failures while stale keep the SAME original confirmedAt/data, only the error text updates", () => {
    const loaded = reducePollState(initialPollState, { type: "success", data: { n: 1 }, now: 100 });
    const stale1 = reducePollState(loaded, { type: "failure", error: "first" });
    const stale2 = reducePollState(stale1, { type: "failure", error: "second" });
    expect(stale2).toEqual({ kind: "stale", data: { n: 1 }, confirmedAt: 100, error: "second" });
  });

  test("a later success recovers from stale/error back to loaded with fresh data", () => {
    const loaded = reducePollState(initialPollState, { type: "success", data: { n: 1 }, now: 100 });
    const stale = reducePollState(loaded, { type: "failure", error: "down" });
    const recovered = reducePollState(stale, { type: "success", data: { n: 2 }, now: 200 });
    expect(recovered).toEqual({ kind: "loaded", data: { n: 2 }, confirmedAt: 200 });
  });

  test("MUTATION CHECK: a mutation that shows stale data as fresh (dropping the stale->error-carrying branch, collapsing it to `loaded`) turns this test red", () => {
    const loaded = reducePollState(initialPollState, { type: "success", data: { n: 1 }, now: 100 });
    const stale = reducePollState(loaded, { type: "failure", error: "down" });
    expect(stale.kind).toBe("stale");
    expect(stale.kind).not.toBe("loaded");
  });
});

describe("nextBackoffMs (pure) — FACTORY-614", () => {
  test("doubles per consecutive failure, starting at `baseMs` for the first failure (consecutiveFailures=0)", () => {
    expect(nextBackoffMs(0, 1000, 30_000)).toBe(1000);
    expect(nextBackoffMs(1, 1000, 30_000)).toBe(2000);
    expect(nextBackoffMs(2, 1000, 30_000)).toBe(4000);
  });

  test("caps at `maxMs`", () => {
    expect(nextBackoffMs(10, 1000, 30_000)).toBe(30_000);
  });
});
