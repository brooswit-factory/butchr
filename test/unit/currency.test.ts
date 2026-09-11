import { describe, expect, test } from "bun:test";
import { createCurrencyTracker } from "../../src/daemon/currency.js";
import type { CurrencyVerdict } from "../../src/agents/build-currency.js";

const CURRENT: CurrencyVerdict = {
  status: "current",
  base: { ref: "refs/remotes/origin/main", sha: "a".repeat(40), changedAt: "2026-09-01T00:00:00.000Z", changedAtUnknownReason: null, fetchedAt: "2026-09-01T00:00:00.000Z", fetchedAtUnknownReason: null },
  dirtyUndeterminable: false,
};

const STALE: CurrencyVerdict = {
  status: "stale",
  commitsBehind: 3,
  commitsAhead: 0,
  base: { ref: "refs/remotes/origin/main", sha: "b".repeat(40), changedAt: "2026-09-01T00:00:00.000Z", changedAtUnknownReason: null, fetchedAt: "2026-09-01T00:00:00.000Z", fetchedAtUnknownReason: null },
  dirtyUndeterminable: false,
};

describe("createCurrencyTracker", () => {
  test("cold cache: the first snapshot() call computes inline and caches the result, stamped with checkedAt", () => {
    let calls = 0;
    const t = createCurrencyTracker({ compute: () => { calls++; return CURRENT; }, now: () => 1_000, intervalMs: 60_000 });
    const snap = t.snapshot();
    expect(calls).toBe(1);
    expect(snap.verdict).toEqual(CURRENT);
    expect(snap.checkedAt).toBe(new Date(1_000).toISOString());
  });

  test("a second call within the interval does not recompute — serves the cached verdict with its original checkedAt", () => {
    let calls = 0;
    let now = 1_000;
    const t = createCurrencyTracker({ compute: () => { calls++; return CURRENT; }, now: () => now, intervalMs: 60_000 });
    const first = t.snapshot();
    now = 1_000 + 30_000; // well within the 60s interval
    const second = t.snapshot();
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("a call after the interval has elapsed recomputes, and the served age advances", () => {
    let calls = 0;
    let now = 1_000;
    const t = createCurrencyTracker({
      compute: () => { calls++; return calls === 1 ? CURRENT : STALE; },
      now: () => now,
      intervalMs: 60_000,
    });
    const first = t.snapshot();
    now = 1_000 + 60_000; // exactly at the interval boundary — due for a recompute
    const second = t.snapshot();
    expect(calls).toBe(2);
    expect(first.verdict).toEqual(CURRENT);
    expect(second.verdict).toEqual(STALE);
    expect(second.checkedAt).not.toBe(first.checkedAt);
    expect(second.checkedAt).toBe(new Date(now).toISOString());
  });

  test("compute() throwing unexpectedly still yields unknown with a reason — never a plausible default, and never a thrown exception out of snapshot()", () => {
    const t = createCurrencyTracker({ compute: () => { throw new Error("git binary vanished"); }, now: () => 0 });
    const snap = t.snapshot();
    expect(snap.verdict.status).toBe("unknown");
    if (snap.verdict.status === "unknown") expect(snap.verdict.reason).toContain("git binary vanished");
    expect(snap.checkedAt).not.toBeNull();
  });

  test("unknown is machine-distinguishable from current by verdict.status alone, not merely by reading a reason string", () => {
    const t = createCurrencyTracker({ compute: () => ({ status: "unknown", reason: "no local base ref" }), now: () => 0 });
    const snap = t.snapshot();
    expect(snap.verdict.status).toBe("unknown");
    expect(snap.verdict.status).not.toBe("current");
  });
});
