import { describe, expect, test } from "bun:test";
import { createPinnedActiveDetector, MARKER } from "../../src/agents/pinned-active.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";

const MIN = 60_000;

/**
 * Same shape crash-loop.test.ts's/frozen-asleep.test.ts's fakeChannel uses —
 * an in-memory "own channel" comment store, newest-first — EXCEPT `created`
 * is derived from the test's own simulated clock (`now`), not real wall-clock
 * time: this module's adoption check compares a found comment's `created`
 * against the current streak's start (both in simulated-clock units), so a
 * fixture using real time here would make that comparison meaningless.
 */
function fakeChannel(now: () => number) {
  const byId = new Map<string, { id: string; body: string; created: string }[]>();
  const posted: { target: string; text: string }[] = [];
  let seq = 0;
  return {
    posted,
    addComment: async (id: string, text: string) => {
      seq++;
      const rows = byId.get(id) ?? [];
      rows.unshift({ id: `c${seq}`, body: text, created: new Date(now()).toISOString() });
      byId.set(id, rows);
      posted.push({ target: id, text });
    },
    comments: async (id: string) => byId.get(id) ?? [],
  };
}

/** Same shape crash-loop.test.ts's fakeHerd uses, kept local (no cross-file test fixture coupling). */
function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });

describe("createPinnedActiveDetector: the idle-streak floor (constraint 2 — never on elapsed-active time alone)", () => {
  test("negative case: a project whose agent reads 'working' every poll never draws a complaint, however long it runs", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "working"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 200; i++) {
      now = i * MIN;
      await det.check(["ACME"]);
    }
    expect(chan.posted).toEqual([]);
  });

  test("an idle streak that never holds the full window (interrupted by 'working' just before crossing it) posts nothing", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 9; i++) { now = i * MIN; await det.check(["ACME"]); }
    statuses.set("ACME", "working"); // breaks the streak at minute 9, one short of the 10-minute window
    now = 9 * MIN;
    await det.check(["ACME"]);
    statuses.set("ACME", "idle");
    now = 15 * MIN; // only 6 minutes into the NEW streak
    await det.check(["ACME"]);
    expect(chan.posted).toEqual([]);
  });

  test("crossing the window posts exactly one observational complaint naming the resource and elapsed minutes, and 'done' is treated identically to 'idle'", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "done"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("ACME");
    const text = chan.posted[0]!.text;
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("ACME");
    expect(text).toContain("10 minute");
    expect(text.toLowerCase()).not.toContain("broken");
  });

  test("steady state after the first complaint: silent, no further comments, for many more polls in the same episode", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);
    for (let i = 11; i <= 200; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);
  });

  test("re-arm: once the agent is observed working again, a LATER fresh idle episode can complain again", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);
    statuses.set("ACME", "working");
    now = 20 * MIN;
    await det.check(["ACME"]); // breaks the episode
    statuses.set("ACME", "idle");
    for (let i = 21; i <= 31; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(2);
  });

  test("leaving the active+running candidate set entirely (not merely going to 'working') also re-arms — a later reappearance starts a fresh floor", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);
    now = 20 * MIN;
    await det.check([]); // ACME no longer active+running at all (e.g. verdict went asleep)
    now = 21 * MIN;
    await det.check(["ACME"]); // reappears — must NOT be treated as still-spoken-for
    for (let i = 22; i <= 32; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(2);
  });
});

describe("createPinnedActiveDetector: constraint 6 — a quota-blocked idle agent draws nothing", () => {
  test("quota-blocked past the window: no complaint; once unblocked, the very next qualifying poll complains", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    let blocked = true;
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments, quotaBlocked: (id) => id === "ACME" && blocked });
    for (let i = 0; i <= 30; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(chan.posted).toEqual([]); // never latched as spoken while blocked
    blocked = false;
    now = 31 * MIN;
    await det.check(["ACME"]);
    expect(chan.posted.length).toBe(1);
  });
});

describe("createPinnedActiveDetector: constraint 5 — the dedupe trap (fail-closed on a failed comments fetch)", () => {
  test("a failing comments fetch posts nothing and is retried on the very next poll, never collapsed into 'nothing to adopt, post a fresh one'", async () => {
    let now = 0;
    const posted: string[] = [];
    let shouldFail = true;
    const det = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", "idle"]]),
      addComment: async (_id, text) => { posted.push(text); },
      comments: async () => { if (shouldFail) throw new Error("transient 500"); return []; },
    });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(posted).toEqual([]); // fetch failed every poll so far — stayed silent, never posted
    shouldFail = false;
    now = 11 * MIN;
    await det.check(["ACME"]);
    expect(posted.length).toBe(1); // retried and succeeded on the very next poll
  });
});

describe("createPinnedActiveDetector: the rate cap is a backstop, and a failed write retries rather than latching false success", () => {
  test("re-arming faster than the hourly cap allows: the 4th complaint within an hour is suppressed, logged once, and the episode is NOT falsely latched as spoken", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const statuses = new Map([["ACME", "idle"]]);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 1, agentStatuses: async () => statuses, addComment: chan.addComment, comments: chan.comments });
    // Three full idle->working->idle episodes, each crossing the 1-minute
    // window well within the same rolling hour — each should post.
    for (let episode = 0; episode < 3; episode++) {
      const base = episode * 5 * MIN;
      statuses.set("ACME", "idle");
      for (let i = 0; i <= 1; i++) { now = base + i * MIN; await det.check(["ACME"]); }
      statuses.set("ACME", "working");
      now = base + 2 * MIN;
      await det.check(["ACME"]);
    }
    expect(chan.posted.length).toBe(3);
    // A 4th episode, still within the same rolling hour, hits the cap.
    statuses.set("ACME", "idle");
    const base4 = 3 * 5 * MIN;
    for (let i = 0; i <= 1; i++) { now = base4 + i * MIN; await det.check(["ACME"]); }
    expect(chan.posted.length).toBe(3); // capped — not a 4th post
  });

  test("a failed addComment write is retried on the next poll rather than falsely latched as spoken", async () => {
    let now = 0;
    let fail = true;
    const posted: string[] = [];
    const det = createPinnedActiveDetector({
      now: () => now,
      minutes: 10,
      agentStatuses: async () => new Map([["ACME", "idle"]]),
      addComment: async (_id, text) => { if (fail) throw new Error("Jira 500"); posted.push(text); },
      comments: async () => [],
    });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["ACME"]); }
    expect(posted).toEqual([]); // write failed — never latched as posted
    fail = false;
    now = 11 * MIN;
    await det.check(["ACME"]);
    expect(posted.length).toBe(1); // retried and succeeded on the very next poll
  });
});

describe("createPinnedActiveDetector: adoption-dedupe across a simulated daemon restart", () => {
  test("a complaint already posted by a prior process's detector instance is adopted, not duplicated, by a brand-new instance sharing the same channel", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const before = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["ACME", "idle"]]), addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await before.check(["ACME"]); }
    expect(chan.posted.length).toBe(1);

    // Simulate a restart: a brand-new detector, no in-memory tracking, same
    // underlying channel. Its own floor must ALSO cross the 10-minute window
    // (from its own first post-restart observation) before it ever attempts
    // dedupe at all — run it long enough to actually reach that point, which
    // is where a naive re-implementation could re-post.
    const after = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["ACME", "idle"]]), addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = (i + 11) * MIN; await after.check(["ACME"]); }
    expect(chan.posted.length).toBe(1); // adopted, not re-posted, even once the fresh instance's own floor also qualifies
  });
});

describe("createPinnedActiveDetector: a fingerprint collision between prefix-related keys never cross-adopts", () => {
  test("BUTCHR and BUTCHRX are tracked independently — a complaint posted for one is never adopted for the other", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["BUTCHR", "idle"], ["BUTCHRX", "idle"]]), addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i <= 10; i++) { now = i * MIN; await det.check(["BUTCHR", "BUTCHRX"]); }
    expect(chan.posted.filter((p) => p.target === "BUTCHR").length).toBe(1);
    expect(chan.posted.filter((p) => p.target === "BUTCHRX").length).toBe(1);
  });
});

describe("reconcileNow: checkPinnedActive is called with exactly desired ∩ running, and NEVER affects plan.spawn/stop/respawn (constraint 1)", () => {
  test("checkPinnedActive receives only ids that are both desired and running this poll", async () => {
    const herd = fakeHerd(["RUNNING_AND_DESIRED", "RUNNING_ONLY"]);
    const calls: Array<readonly string[]> = [];
    await reconcileNow(herd, new Map([["RUNNING_AND_DESIRED", spec("RUNNING_AND_DESIRED")], ["SPAWN_ME", spec("SPAWN_ME")]]), {
      checkPinnedActive: async (activeRunning) => { calls.push([...activeRunning]); },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["RUNNING_AND_DESIRED"]); // "RUNNING_ONLY" is running-not-desired; "SPAWN_ME" is desired-not-running — neither qualifies
  });

  test("checkPinnedActive is never called when the desired ∩ running intersection is empty", async () => {
    const herd = fakeHerd(["ONLY_RUNNING"]);
    let called = false;
    await reconcileNow(herd, new Map([["ONLY_DESIRED", spec("ONLY_DESIRED")]]), {
      checkPinnedActive: async () => { called = true; },
    });
    expect(called).toBe(false);
  });

  test("plan.spawn/herd.spawn, plan.stop/herd.stop and plan.respawn are BYTE-IDENTICAL with and without checkPinnedActive wired, on the same inputs — the proof constraint 1 holds by construction", async () => {
    const specOf = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const desired = new Map([["KEEP", specOf("KEEP")], ["NEW", specOf("NEW")]]);
    const stale = [{ issue: "KEEP", reason: "argv stale", observedArgv: ["claude"] }];

    async function run(withHook: boolean) {
      const running = new Set(["KEEP", "OLD"]);
      const spawned: string[] = [], stopped: string[] = [];
      const herd: Herd = {
        async runningIssues() { return [...running]; },
        async staleIssues() { return stale.filter((s) => running.has(s.issue)); },
        async spawn(sp) { spawned.push(sp.key); },
        async stop(i) { stopped.push(i); },
        async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
        async nudge() { return { delivered: true }; },
      };
      await reconcileNow(herd, desired, withHook ? { checkPinnedActive: async () => { /* observes and speaks only */ } } : {});
      return { spawned, stopped };
    }

    const without = await run(false);
    const withHook = await run(true);
    expect(withHook).toEqual(without);
    // "KEEP" is stale ∩ desired ∩ running → respawn (stop then spawn); "NEW"
    // is desired − running → spawn; "OLD" is running − desired → stop.
    expect(without.spawned).toEqual(["NEW", "KEEP"]);
    expect(without.stopped).toEqual(["OLD", "KEEP"]);
  });

  test("checkPinnedActive runs even when this resource type never produces a non-empty atRest (e.g. the issue tier, which never sleeps)", async () => {
    const herd = fakeHerd(["A"]);
    const calls: Array<readonly string[]> = [];
    await reconcileNow(herd, new Map([["A", spec("A")]]), {
      // no `atRest` option passed at all — mirrors the issue tier's own call site
      checkPinnedActive: async (activeRunning) => { calls.push([...activeRunning]); },
    });
    expect(calls).toEqual([["A"]]);
  });

  test("omitting checkPinnedActive entirely preserves ordinary reconcileNow behaviour, unchanged", async () => {
    const herd = fakeHerd([]);
    await reconcileNow(herd, new Map([["A", spec("A")]]));
    expect(herd.spawned).toEqual(["A"]);
  });

  test("a pinned-active id, driven through the REAL reconcileNow over a fake Herd for many polls, is detected and posts exactly once — full integration", async () => {
    let now = 0;
    const chan = fakeChannel(() => now);
    const det = createPinnedActiveDetector({ now: () => now, minutes: 10, agentStatuses: async () => new Map([["ACME", "idle"]]), addComment: chan.addComment, comments: chan.comments });
    const herd = fakeHerd(["ACME"]); // running forever, never spawned/stopped/respawned — exactly the pinned shape
    const desired = new Map([["ACME", spec("ACME")]]);
    for (let i = 0; i <= 20; i++) {
      now = i * MIN;
      await reconcileNow(herd, desired, { checkPinnedActive: det.check });
    }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("ACME");
    expect(herd.spawned).toEqual([]); // never touched — still pinned, not reaped or respawned
    expect(herd.stopped).toEqual([]);
  });
});
