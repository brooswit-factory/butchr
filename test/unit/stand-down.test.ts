import { describe, expect, test } from "bun:test";
import { createStandDownRegistry, YIELD_LOOP_MARKER } from "../../src/agents/stand-down.js";

const MIN = 60_000;

/** Same shape test/unit/frozen-asleep.test.ts's fakeChannel uses: an in-memory per-id comment store, newest-first. */
function fakeChannel() {
  const byId = new Map<string, { id: string; body: string; created: string }[]>();
  const posted: { target: string; text: string }[] = [];
  let seq = 0;
  return {
    posted,
    addComment: async (id: string, text: string) => {
      seq++;
      const rows = byId.get(id) ?? [];
      rows.unshift({ id: `c${seq}`, body: text, created: new Date().toISOString() });
      byId.set(id, rows);
      posted.push({ target: id, text });
    },
    comments: async (id: string) => byId.get(id) ?? [],
  };
}

function registry(overrides: { now?: () => number; maxSleepMinutes?: number; yieldLoopCount?: number; yieldLoopWindowMinutes?: number } = {}, chan = fakeChannel()) {
  let now = 0;
  const reg = createStandDownRegistry({
    now: overrides.now ?? (() => now),
    maxSleepMinutes: overrides.maxSleepMinutes ?? 60,
    yieldLoopCount: overrides.yieldLoopCount ?? 5,
    yieldLoopWindowMinutes: overrides.yieldLoopWindowMinutes ?? 5,
    addComment: chan.addComment,
    comments: chan.comments,
  });
  return { reg, chan, setNow: (n: number) => { now = n; } };
}

describe("createStandDownRegistry: standDown/isAsleep/hasBaseline — the basic sleep record", () => {
  test("standDown(id, seen) marks id asleep; a fresh id is not", () => {
    const { reg } = registry();
    expect(reg.isAsleep("KAN-1")).toBe(false);
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    expect(reg.isAsleep("KAN-1")).toBe(true);
  });

  test("hasBaseline is true only for a ticket present in the seen map at stand-down, false for one absent (e.g. a worker created afterward)", () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]], ["KAN-2", ["200"]]]));
    expect(reg.hasBaseline("KAN-1", "KAN-1")).toBe(true);
    expect(reg.hasBaseline("KAN-1", "KAN-2")).toBe(true);
    expect(reg.hasBaseline("KAN-1", "KAN-3")).toBe(false);
  });

  test("a fresh standDown call REPLACES the prior record for the same id, never accumulates onto it", () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    expect(reg.hasBaseline("KAN-1", "KAN-2")).toBe(false);
    // A second episode watches a different ticket set (e.g. the old worker finished, a new one started).
    reg.standDown("KAN-1", new Map([["KAN-2", ["200"]]]));
    expect(reg.hasBaseline("KAN-1", "KAN-1")).toBe(false); // the OLD watched ticket is gone, not merged
    expect(reg.hasBaseline("KAN-1", "KAN-2")).toBe(true);
  });
});

describe("createStandDownRegistry: unseenFor — set membership only (BUTCHR-227's rule), reused via unseenIds", () => {
  test("an id in observed but not in the recorded seen set is unseen", () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    expect(reg.unseenFor("KAN-1", "KAN-1", ["100", "101"])).toEqual(["101"]);
  });

  test("no ordering/magnitude dependence: a NON-monotonic (lower) new id is still recognized as unseen, and an id lower than the seen set is not falsely flagged", () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["500"]]]));
    // A comment id lower than one already seen is exactly the shape BUTCHR-198/227 measured Confluence/Jira ids do NOT guarantee against.
    expect(reg.unseenFor("KAN-1", "KAN-1", ["500", "300"])).toEqual(["300"]);
  });

  test("empty when the id has no baseline for that key (caller must check hasBaseline first)", () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    expect(reg.unseenFor("KAN-1", "KAN-2", ["999"])).toEqual([]);
    expect(reg.hasBaseline("KAN-1", "KAN-2")).toBe(false); // confirms the empty result above means "no baseline", not "nothing unseen"
  });

  test("empty when the id is not asleep at all", () => {
    const { reg } = registry();
    expect(reg.unseenFor("KAN-1", "KAN-1", ["100"])).toEqual([]);
  });
});

describe("createStandDownRegistry: wake — clears sleep, one-shot crash-loop exemption, reason-tagged log", () => {
  test("wake('edge') clears isAsleep and is a no-op (but still logs nothing new) on an id that was never asleep", async () => {
    const { reg } = registry();
    await reg.wake("KAN-1", "edge"); // never asleep — no-op
    expect(reg.isAsleep("KAN-1")).toBe(false);

    reg.standDown("KAN-1", new Map());
    expect(reg.isAsleep("KAN-1")).toBe(true);
    await reg.wake("KAN-1", "edge");
    expect(reg.isAsleep("KAN-1")).toBe(false);
  });

  test("a woken id is exempt from the NEXT crash-loop check (consumeCrashLoopExemptions), exactly once", async () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(reg.consumeCrashLoopExemptions(["KAN-1", "KAN-2"])).toEqual(["KAN-2"]); // KAN-1 filtered out, exemption consumed
    expect(reg.consumeCrashLoopExemptions(["KAN-1"])).toEqual(["KAN-1"]); // the exemption does not repeat
  });

  test("a withheld (never-admitted) candidate keeps its exemption across polls — consumeCrashLoopExemptions is only ever called with `admitted`", async () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    // Two polls where KAN-1 is never in `admitted` (e.g. withheld by the admission cap) must not silently expire the exemption.
    expect(reg.consumeCrashLoopExemptions([])).toEqual([]);
    expect(reg.consumeCrashLoopExemptions([])).toEqual([]);
    expect(reg.consumeCrashLoopExemptions(["KAN-1"])).toEqual([]); // still exempt once it IS finally admitted
  });
});

describe("createStandDownRegistry: tickMaxSleep — the lost-wake bound", () => {
  test("below the bound: no-op, still asleep, returns false", async () => {
    const { reg, setNow } = registry({ maxSleepMinutes: 60 });
    setNow(0);
    reg.standDown("KAN-1", new Map());
    setNow(59 * MIN);
    expect(await reg.tickMaxSleep("KAN-1")).toBe(false);
    expect(reg.isAsleep("KAN-1")).toBe(true);
  });

  test("at/past the bound: force-wakes with reason 'bound', returns true, and the id is no longer asleep", async () => {
    const { reg, setNow } = registry({ maxSleepMinutes: 60 });
    setNow(0);
    reg.standDown("KAN-1", new Map());
    setNow(60 * MIN);
    expect(await reg.tickMaxSleep("KAN-1")).toBe(true);
    expect(reg.isAsleep("KAN-1")).toBe(false);
  });

  test("a no-op on an id that isn't asleep at all", async () => {
    const { reg } = registry();
    expect(await reg.tickMaxSleep("KAN-1")).toBe(false);
  });

  test("a bound-triggered wake does NOT count toward the yield-loop window (only edge wakes do) — five consecutive bound-wakes never post a yieldloop complaint", async () => {
    const { reg, chan, setNow } = registry({ maxSleepMinutes: 10, yieldLoopCount: 3, yieldLoopWindowMinutes: 5 });
    for (let i = 0; i < 5; i++) {
      setNow(i * 20 * MIN);
      reg.standDown("KAN-1", new Map());
      setNow(i * 20 * MIN + 10 * MIN);
      expect(await reg.tickMaxSleep("KAN-1")).toBe(true);
    }
    expect(chan.posted.some((p) => p.text.startsWith(YIELD_LOOP_MARKER))).toBe(false);
  });
});

describe("createStandDownRegistry: the yield loop — edge wakes of the same id, bounded and distinct from crash-loop", () => {
  test("fewer edge-wakes than the count, all inside the window: no complaint", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 5, yieldLoopWindowMinutes: 5 });
    for (let i = 0; i < 4; i++) {
      setNow(i * MIN);
      reg.standDown("KAN-1", new Map());
      await reg.wake("KAN-1", "edge");
    }
    expect(chan.posted).toEqual([]);
  });

  test("reaching the count inside the window posts a [butchr:yieldloop] complaint naming the resource, distinct from crash-loop's own marker", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 3, yieldLoopWindowMinutes: 5 });
    for (let i = 0; i < 3; i++) {
      setNow(i * MIN);
      reg.standDown("KAN-1", new Map());
      await reg.wake("KAN-1", "edge");
    }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("KAN-1");
    expect(chan.posted[0]!.text.startsWith(YIELD_LOOP_MARKER)).toBe(true);
    expect(chan.posted[0]!.text).toContain("resource: [KAN-1]");
    expect(YIELD_LOOP_MARKER).not.toBe("[butchr:crashloop]");
  });

  test("does not re-post every subsequent wake once already spoken for the same cluster", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 3, yieldLoopWindowMinutes: 5 });
    for (let i = 0; i < 5; i++) {
      setNow(i * MIN);
      reg.standDown("KAN-1", new Map());
      await reg.wake("KAN-1", "edge");
    }
    expect(chan.posted.length).toBe(1); // wakes 3, 4, 5 do not re-post
  });

  test("edge wakes outside the rolling window do not accumulate toward the count", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 3, yieldLoopWindowMinutes: 5 });
    setNow(0);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    setNow(1 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    // Far outside the 5-minute window — the first two wakes have expired.
    setNow(100 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(chan.posted).toEqual([]);
  });

  test("the window emptying out drops the latch, so a LATER cluster re-checks — but findMarked adopts the still-present first complaint rather than posting a second (same known, accepted fingerprint-only-dedupe limitation as every other detector in this family — see crash-loop.test.ts's identical case)", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 2, yieldLoopWindowMinutes: 5 });
    setNow(0);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    setNow(1 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(chan.posted.length).toBe(1);

    // Long gap — the tracked window empties entirely, dropping the "already spoken" latch too.
    setNow(100 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    setNow(101 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(chan.posted.length).toBe(1); // adopted the first cluster's still-present comment, not re-posted
  });

  test("daemon-restart adoption: an existing [butchr:yieldloop] comment for this id is adopted instead of re-posted", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 2, yieldLoopWindowMinutes: 5 });
    await chan.addComment("KAN-1", `${YIELD_LOOP_MARKER} KAN-1 has woken from stand_down 2 times in the last 5 minutes.\n\nresource: [KAN-1]`);
    const postedBefore = chan.posted.length;
    setNow(0);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    setNow(1 * MIN);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(chan.posted.length).toBe(postedBefore); // adopted, not re-posted
  });

  test("rate cap: no more than 3 complaints per id per hour, even across fresh episodes — isolated from adoption via an always-empty comments() (same technique crash-loop.test.ts's own rate-cap test uses)", async () => {
    let now = 0;
    const posted: { target: string; text: string }[] = [];
    const logs: string[] = [];
    const reg = createStandDownRegistry({
      now: () => now,
      maxSleepMinutes: 60,
      yieldLoopCount: 2,
      yieldLoopWindowMinutes: 5,
      addComment: async (id, text) => { posted.push({ target: id, text }); },
      comments: async () => [], // never sees its own posted comments — isolates the cap from adoption
      log: (l) => logs.push(l),
    });
    for (let cluster = 0; cluster < 5; cluster++) {
      for (let i = 0; i < 2; i++) {
        now = cluster * 10 * MIN + i * MIN;
        reg.standDown("KAN-1", new Map());
        await reg.wake("KAN-1", "edge");
      }
    }
    expect(posted.length).toBe(3); // MAX_PER_HOUR, even across 5 fresh clusters within the hour
    expect(logs.some((l) => l.startsWith("WARNING: [yieldloop]") && l.includes("rate cap"))).toBe(true);
  });

  test("a rejected comments() fetch fails CLOSED for the dedupe check — no complaint posted this call, retried on a later wake, never posted blind", async () => {
    let now = 0;
    const posted: { target: string; text: string }[] = [];
    const logs: string[] = [];
    const reg = createStandDownRegistry({
      now: () => now,
      maxSleepMinutes: 60,
      yieldLoopCount: 1,
      yieldLoopWindowMinutes: 5,
      addComment: async (id, text) => { posted.push({ target: id, text }); },
      comments: async () => { throw new Error("boom"); },
      log: (l) => logs.push(l),
    });
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    expect(posted).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARNING: [yieldloop]") && l.includes("comments fetch failed"))).toBe(true);
  });
});

describe("createStandDownRegistry: forgetMissing — bounds memory to currently-active issues", () => {
  test("drops the sleep record, the crash-loop exemption, and yield-loop bookkeeping for an id no longer present", async () => {
    const { reg } = registry();
    reg.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    await reg.wake("KAN-1", "edge"); // sets a one-shot crash-loop exemption
    reg.standDown("KAN-2", new Map());

    reg.forgetMissing(new Set(["KAN-2"])); // KAN-1 has left the active JQL result set entirely

    expect(reg.isAsleep("KAN-1")).toBe(false);
    expect(reg.hasBaseline("KAN-1", "KAN-1")).toBe(false);
    expect(reg.consumeCrashLoopExemptions(["KAN-1"])).toEqual(["KAN-1"]); // exemption is gone too
    expect(reg.isAsleep("KAN-2")).toBe(true); // untouched
  });

  test("a forgotten id's edge-wake COUNT resets — a single wake right after forgetMissing does not immediately re-trigger the threshold it was one wake away from", async () => {
    const { reg, chan, setNow } = registry({ yieldLoopCount: 2, yieldLoopWindowMinutes: 5 });
    setNow(0);
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge"); // 1 of 2 — one wake short of the threshold

    reg.forgetMissing(new Set()); // KAN-1 leaves the active set entirely — drops the count, not just the latch

    setNow(1 * MIN); // still inside what would have been the old window
    reg.standDown("KAN-1", new Map());
    await reg.wake("KAN-1", "edge");
    // If the count had survived forgetMissing, this would be the 2nd wake and
    // would trip the threshold. It is instead the 1st wake of a fresh count.
    expect(chan.posted).toEqual([]);
  });
});
