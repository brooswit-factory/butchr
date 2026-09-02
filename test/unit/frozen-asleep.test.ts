import { describe, expect, test } from "bun:test";
import { createFrozenAsleepDetector, MARKER } from "../../src/agents/frozen-asleep.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";

const MIN = 60_000;

/** A fake "own channel" comment store: addComment writes land here, newest-first — same shape test/unit/parked.test.ts's fakeJira uses. */
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

describe("createFrozenAsleepDetector: the bound itself (BUTCHR-95/123 DoD 4/8 — the race, in both directions)", () => {
  test("inside the bound: no complaint, and the id is NOT reported frozen — leave alone, say nothing", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });

    now = 0;
    let out = await det.check(["S1"]); // floor starts at 0
    expect(out.size).toBe(0);
    expect(chan.posted).toEqual([]);

    now = 9 * MIN;
    out = await det.check(["S1"]); // still short of the 10-minute bound
    expect(out.size).toBe(0);
    expect(chan.posted).toEqual([]);
  });

  test("past the bound: a complaint is posted, naming the resource and elapsed time, and the id is reported frozen (eligible to reap)", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });

    now = 0;
    await det.check(["S1"]);
    now = 10 * MIN;
    const out = await det.check(["S1"]);
    expect(out.has("S1")).toBe(true);
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("S1");
    expect(chan.posted[0]!.text.startsWith(MARKER)).toBe(true);
    expect(chan.posted[0]!.text).toContain("S1");
    expect(chan.posted[0]!.text).toContain("fingerprint: S1");
    expect(chan.posted[0]!.text).toContain("10 minutes"); // observational: the measured elapsed time, not an accusation
    expect(chan.posted[0]!.text.toLowerCase()).not.toContain("mistake");
    // "what is being done about it" (epic criterion 3) — states the reap, and states it is a reap, not a respawn.
    expect(chan.posted[0]!.text.toLowerCase()).toContain("stopped");
  });

  test("once spoken, stays reported frozen on every later poll with NO further comments-fetch or post (latched, not re-checked)", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fetches = 0;
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: chan.addComment,
      comments: async (id) => { fetches++; return chan.comments(id); },
    });
    await det.check(["S1"]);
    now = 10 * MIN;
    await det.check(["S1"]);
    expect(chan.posted.length).toBe(1);
    const fetchesAfterFirstPost = fetches;

    now = 11 * MIN;
    const out = await det.check(["S1"]);
    expect(out.has("S1")).toBe(true);
    expect(chan.posted.length).toBe(1); // no duplicate
    expect(fetches).toBe(fetchesAfterFirstPost); // no extra I/O once latched
  });

  test("the reset/forget path: an id that stops being a candidate (woke for real, or was actually reaped) starts a FRESH floor on a later re-freeze, rather than being immediately reported frozen from a stale latch", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });

    await det.check(["S1"]); // floor #1 starts at 0
    now = 10 * MIN;
    await det.check(["S1"]); // spoken — frozen
    expect(chan.posted.length).toBe(1);

    now = 15 * MIN;
    await det.check([]); // S1 no longer a candidate at all (e.g. actually stopped) — forgetMissing drops it

    now = 16 * MIN;
    const out = await det.check(["S1"]); // re-enters — a FRESH floor starts here (16min), not the original
    expect(out.size).toBe(0); // not yet 10 minutes since the NEW floor
    expect(chan.posted.length).toBe(1); // no premature re-post

    now = 25 * MIN; // 9 minutes since the fresh floor — still short
    await det.check(["S1"]);
    expect(chan.posted.length).toBe(1);

    now = 26 * MIN; // 10 minutes since the fresh floor (16min)
    const out2 = await det.check(["S1"]);
    // The floor genuinely reset (the two assertions above already prove
    // that — a stale floor would have fired back at 16min). What happens
    // NOW is a known, SHARED limitation with parked.ts's identical
    // fingerprint-only dedupe: the first episode's complaint is still
    // sitting on the channel (real comment stores never delete), so
    // `findMarked` finds and ADOPTS it rather than posting a fresh one for
    // this second episode — same as a second, unrelated parking of the same
    // child would adopt its own first `stage: 1` comment. The id is still
    // correctly reported frozen (reapable) either way.
    expect(out2.has("S1")).toBe(true);
    expect(chan.posted.length).toBe(1); // adopted the FIRST episode's complaint, not a fresh post
  });

  test("dedupe survives a simulated daemon restart: a FRESH detector (fresh in-memory tracker) with the prior complaint already on the channel adopts it instead of re-posting, and reports the id frozen immediately", async () => {
    let now = 0;
    const chan = fakeChannel();
    const before = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });
    await before.check(["S1"]);
    now = 10 * MIN;
    await before.check(["S1"]);
    expect(chan.posted.length).toBe(1);

    // Simulate the restart: a brand new detector, no memory of S1 at all,
    // but the SAME underlying channel comments — the complaint `before`
    // posted is still there.
    now = 12 * MIN;
    const after = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });
    const out = await after.check(["S1"]); // immediately re-checks against the bound... but the floor is fresh (12min) so it's NOT yet 10min from `after`'s own perspective
    expect(out.size).toBe(0);
    expect(chan.posted.length).toBe(1);

    now = 22 * MIN; // 10 minutes after `after`'s own fresh floor: eligible to (re-)attempt
    const out2 = await after.check(["S1"]);
    expect(out2.has("S1")).toBe(true);
    expect(chan.posted.length).toBe(1); // adopted the EXISTING complaint — no duplicate posted
  });
});

describe("createFrozenAsleepDetector: the dedupe trap, promoted to a hard requirement (BUTCHR-95/123) — 'could not check' must never take the same branch as 'checked, nothing found'", () => {
  test("a comments() fetch failure fails CLOSED: no post, id NOT reported frozen, no throw — and a later successful poll still posts", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fail = true;
    const logs: string[] = [];
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: chan.addComment,
      comments: async (id) => { if (fail) throw new Error("project key not addressable as an issue (404)"); return chan.comments(id); },
      log: (l) => logs.push(l),
    });
    await det.check(["S1"]);
    now = 10 * MIN;
    const out = await det.check(["S1"]); // comments() throws -> fails closed
    expect(out.size).toBe(0); // NOT reported frozen — stays protected
    expect(chan.posted).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING: [frozen]") && l.includes("comments fetch failed"))).toBe(true);

    fail = false;
    now = 11 * MIN;
    const out2 = await det.check(["S1"]); // comments() now succeeds -> posts and reports frozen
    expect(out2.has("S1")).toBe(true);
    expect(chan.posted.length).toBe(1);
  });

  test("a fetch failure never re-posts even after it starts succeeding again mid-episode without a fresh bound crossing (the same distinct-branches guarantee, shown across many polls)", async () => {
    // FAILS if "could not check" and "checked, nothing found" were ever
    // collapsed into one branch: that would either spam a complaint every
    // poll while failing (re-entering the "nothing found -> post" branch on
    // every failed fetch), or silently reap without ever having spoken (the
    // opposite failure). Neither happens here: only ONE post total, only
    // once the fetch actually succeeds, at or after the bound.
    let now = 0;
    const chan = fakeChannel();
    let fail = true;
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: chan.addComment,
      comments: async (id) => { if (fail) throw new Error("503"); return chan.comments(id); },
    });
    await det.check(["S1"]);
    for (const m of [10, 10.1, 10.2, 10.3]) {
      now = m * MIN;
      await det.check(["S1"]); // still failing every poll
    }
    expect(chan.posted).toEqual([]);
    fail = false;
    now = 10.4 * MIN;
    await det.check(["S1"]);
    expect(chan.posted.length).toBe(1);
  });

  test("a detector-internal throw (e.g. addComment rejects) is caught: check() never rejects, and the id is not reported frozen that poll", async () => {
    let now = 0;
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: async () => { throw new Error("boom"); },
      comments: async () => [],
    });
    await det.check(["S1"]);
    now = 10 * MIN;
    await expect(det.check(["S1"])).resolves.toBeInstanceOf(Set);
    const out = await det.check(["S1"]);
    // addComment kept throwing; still never reported frozen, never rejected.
    expect(out.size).toBe(0);
  });
});

describe("createFrozenAsleepDetector: rate cap (BUTCHR-95/123 DoD 6)", () => {
  test("no more than 3 complaints per id per hour", async () => {
    // A freeze/forget/re-freeze cycle, once the FIRST complaint is on the
    // channel, would normally hit the dedupe/adoption branch on every later
    // cycle (see the "reset/forget path" test above) — comment stores don't
    // delete, so `findMarked` would find and adopt the first post forever,
    // never reaching the rate-cap check at all. To exercise the cap itself
    // in isolation, `comments` here always reports empty — standing in for
    // the real, bounded case this cap is defense-in-depth against:
    // `AtlassianClient.comments()` caps at `maxResults` (20, by default) and
    // returns NEWEST-first, so a ticket/page with enough OTHER traffic can
    // genuinely scroll this detector's own marker off the page, making a
    // real "checked, found nothing" outcome indistinguishable from this
    // fake — the cap is what still bounds the damage when that happens.
    let now = 0;
    const chan = fakeChannel();
    const logs: string[] = [];
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 1, addComment: chan.addComment, comments: async () => [], log: (l) => logs.push(l) });

    for (let i = 0; i < 5; i++) {
      // Each cycle: freeze past the bound (posts once), then forget (as if
      // reaped and later frozen again), staying inside one hour throughout.
      now = i * 10 * MIN;
      await det.check(["S1"]);
      now = i * 10 * MIN + 1 * MIN;
      await det.check(["S1"]);
      now = i * 10 * MIN + 2 * MIN;
      await det.check([]); // forget — simulates the reap actually taking effect
    }
    expect(chan.posted.length).toBe(3); // capped at 3/hour even across 5 re-freeze cycles
    expect(logs.some((l) => l.startsWith("WARNING: [frozen]") && l.includes("rate cap"))).toBe(true);
  });
});

/** fakeHerd — same shape as sleep.test.ts's, kept local so this file has no cross-file test fixture coupling. */
function fakeHerd(initial: string[] = [], stale: Array<{ issue: string; reason: string; observedArgv: string[] }> = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return stale.filter((s) => running.has(s.issue)); },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

describe("reconcileNow: checkFrozenAsleep bounds atRest in time end to end (BUTCHR-95/123)", () => {
  test("PROBE A, past the bound: an asleep-and-running resource that has been frozen past the bound IS reaped — the complaint lands BEFORE the stop", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });
    const herd = fakeHerd(["S1", "OTHER"]);
    // OTHER is desired-and-running (ordinary machinery, unaffected by this
    // ticket) so it stays untouched throughout — isolates every assertion
    // below to S1's own atRest/frozen behaviour.
    const desired = new Map([["OTHER", { key: "OTHER", issuetype: "sleeper", summary: "s", parent: null }]]);

    now = 0;
    await reconcileNow(herd, desired, { atRest: ["S1"], checkFrozenAsleep: det.check });
    expect(herd.stopped).toEqual([]); // not yet — floor just started

    now = 10 * MIN;
    await reconcileNow(herd, desired, { atRest: ["S1"], checkFrozenAsleep: det.check });
    expect(chan.posted.length).toBe(1); // spoke...
    expect(chan.posted[0]!.target).toBe("S1");
    expect(herd.stopped).toEqual(["S1"]); // ...then acted — never the other order
    expect(herd.running.has("S1")).toBe(false);
    expect(herd.running.has("OTHER")).toBe(true); // untouched — OTHER was never atRest
  });

  test("PROBE A, inside the bound: the SAME setup, short of the bound, reaps nothing and speaks nothing — the race is still guarded in both directions", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });
    const herd = fakeHerd(["S1"], [{ issue: "S1", reason: "argv lacks --x", observedArgv: [] }]);

    now = 0;
    await reconcileNow(herd, new Map(), { atRest: ["S1"], checkFrozenAsleep: det.check });
    now = 9 * MIN;
    await reconcileNow(herd, new Map(), { atRest: ["S1"], checkFrozenAsleep: det.check });

    expect(chan.posted).toEqual([]); // no complaint
    expect(herd.stopped).toEqual([]); // not stopped
    expect(herd.running.has("S1")).toBe(true); // still running
    // Never respawned either, even though flagged stale — respawn intersects
    // `desired`, which S1 (asleep) is never in, by construction; unaffected
    // by checkFrozenAsleep entirely.
  });

  test("PROBE B, past the bound: an asleep-and-running resource flagged STALE is reaped, never respawned, even past the bound", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createFrozenAsleepDetector({ now: () => now, minutes: 10, addComment: chan.addComment, comments: chan.comments });
    const herd = fakeHerd(["S1"], [{ issue: "S1", reason: "argv lacks --x", observedArgv: [] }]);
    let respawns = 0;

    now = 0;
    await reconcileNow(herd, new Map(), { atRest: ["S1"], checkFrozenAsleep: det.check, onRespawn: () => { respawns++; } });
    now = 10 * MIN;
    await reconcileNow(herd, new Map(), { atRest: ["S1"], checkFrozenAsleep: det.check, onRespawn: () => { respawns++; } });

    expect(herd.stopped).toEqual(["S1"]); // reaped...
    expect(respawns).toBe(0); // ...never respawned — `respawn` was never the right verb for an asleep resource (see frozen-asleep.ts's top comment)
  });

  test("CONTROL 1: an inactive-and-running resource (never atRest at all) is stopped normally — checkFrozenAsleep never even sees it", async () => {
    let now = 0;
    let calls = 0;
    const herd = fakeHerd(["BUTCHR"]);
    await reconcileNow(herd, new Map(), {
      atRest: [],
      checkFrozenAsleep: async (ids) => { calls++; return new Set(ids); }, // would reap anything it's asked about — asked about nothing
    });
    expect(herd.stopped).toEqual(["BUTCHR"]);
    expect(calls).toBe(0); // machinery works, and unrelated to this detector
  });

  test("CONTROL 2: an active-and-running-and-STALE resource is respawned normally — atRest and checkFrozenAsleep are irrelevant to it", async () => {
    const herd = fakeHerd(["BUTCHR"], [{ issue: "BUTCHR", reason: "argv lacks --x", observedArgv: [] }]);
    const desired = new Map([["BUTCHR", { key: "BUTCHR", issuetype: "sleeper", summary: "s", parent: null }]]);
    let respawns = 0;
    await reconcileNow(herd, desired, {
      atRest: [],
      checkFrozenAsleep: async (ids) => new Set(ids),
      onRespawn: () => { respawns++; },
    });
    expect(respawns).toBe(1);
  });

  test("omitting checkFrozenAsleep entirely preserves the ORIGINAL unbounded behaviour (every caller before this ticket): atRest protects indefinitely", async () => {
    const herd = fakeHerd(["S1"]);
    await reconcileNow(herd, new Map(), { atRest: ["S1"] }); // no checkFrozenAsleep at all
    expect(herd.stopped).toEqual([]);
    expect(herd.running.has("S1")).toBe(true);
  });
});
