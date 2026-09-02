import { describe, expect, test } from "bun:test";
import { createCrashLoopDetector, CrashLoopTracker, MARKER } from "../../src/agents/crash-loop.js";
import { findMarked } from "../../src/agents/escalation-helper.js";
import { parseDirective } from "../../src/agents/escalate.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../../src/tools/speak.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { Herd } from "../../src/agents/herd.js";

const MIN = 60_000;

/** A fake "own channel" comment store: addComment writes land here, newest-first — same shape frozen-asleep.test.ts's fakeChannel uses. */
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

/** Full AtlassianOps fake, for the real-write-path tests — same shape frozen-asleep.test.ts/speak.test.ts use. */
function makeOps(overrides: Partial<AtlassianOps> = {}): AtlassianOps {
  return {
    getIssue: async () => ({}),
    search: async () => ({}),
    addComment: async () => ({ ok: true }),
    linkIssues: async () => ({}),
    transition: async () => ({}),
    createIssue: async () => ({}),
    setPriority: async () => ({}),
    assign: async () => ({}),
    correctText: async () => ({}),
    createPage: async () => ({}),
    getPage: async (id: string) => ({ title: "root doc", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
    updatePage: async () => ({ ok: true }),
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    getProjectProperty: async (projectKey: string) => {
      if (projectKey !== "BUTCHR") throw new Error(`fake: no "butchr" property for ${projectKey}`);
      return { space: { key: "BUTCHR" }, rootDoc: { id: "42" } };
    },
    getRemoteLink: async () => null,
    upsertRemoteLink: async () => ({}),
    getChildPages: async () => ({ results: [] }),
    getPageLabels: async () => [],
    createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),
    commentOnPage: async () => ({ ok: true, id: "1000" }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: "test-account" }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    ...overrides,
  };
}

describe("createCrashLoopDetector: the threshold itself", () => {
  test("negative case: a healthy resource spawned exactly once produces no comment, ever, over many polls", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    // Spawned once; every later poll it is running, so it never reappears in `plan.spawn` again.
    await det.check(["S1"], ["S1"]);
    for (let i = 1; i <= 20; i++) {
      now = i * MIN;
      await det.check([], ["S1"]); // still desired, but not spawning — healthy
    }
    expect(chan.posted).toEqual([]);
  });

  test("negative case: a single ordinary respawn (stale-argv replacement) never even reaches this detector — respawn is a disjoint list from plan.spawn", async () => {
    // reconcileNow's `plan.respawn` (stale-argv RUNNING agent replacement) is
    // never passed to checkCrashLoop at all — only `plan.spawn` is. This is
    // asserted at the reconcileNow integration level below; here it's enough
    // to note the detector only ever sees what it's given.
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    await det.check([], ["S1"]); // a respawn never appears in `spawning`
    expect(chan.posted).toEqual([]);
  });

  test("crossing the threshold within the window posts one observational complaint naming the resource, the count, and the window", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 5; i++) {
      now = i * MIN;
      await det.check(["BUTCHR-1"], ["BUTCHR-1"]);
    }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("BUTCHR-1");
    const text = chan.posted[0]!.text;
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("BUTCHR-1");
    expect(text).toContain("5 times");
    expect(text).toContain("60 minutes");
    expect(text).toContain("resource: [BUTCHR-1]");
    expect(text.toLowerCase()).not.toContain("mistake");
  });

  test("a spawn count that never reaches the threshold within the rolling window produces nothing — old spawns fall out of the window", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    // 4 spawns, one per 20 minutes — each one ages out of the 60-minute
    // window before a 5th ever lands within it (0, 20, 40, 60 -> at 60 the
    // spawn at 0 has fallen out, so the window only ever holds at most 3).
    for (let i = 0; i < 6; i++) {
      now = i * 20 * MIN;
      await det.check(["BUTCHR-1"], ["BUTCHR-1"]);
    }
    expect(chan.posted).toEqual([]);
  });

  test("once posted, the id is latched: no further comments-fetch or post while it keeps crash-looping, until it leaves `desired`", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fetches = 0;
    const det = createCrashLoopDetector({
      now: () => now, count: 5, windowMinutes: 60,
      addComment: chan.addComment,
      comments: async (id) => { fetches++; return chan.comments(id); },
    });
    for (let i = 0; i < 5; i++) { now = i * MIN; await det.check(["S1"], ["S1"]); }
    expect(chan.posted.length).toBe(1);
    const fetchesAfterFirstPost = fetches;
    for (let i = 5; i < 10; i++) { now = i * MIN; await det.check(["S1"], ["S1"]); }
    expect(chan.posted.length).toBe(1); // no duplicate
    expect(fetches).toBe(fetchesAfterFirstPost); // no extra I/O once latched
  });
});

describe("createCrashLoopDetector: THE PRUNING TRAP (§2.3) — prune on 'left desired', never on 'absent from plan.spawn this poll'", () => {
  test("a SLOWER crash loop (spawn, live for one poll, die, respawn) still reaches the threshold — pruning is keyed on `desired`, not on this poll's `spawning`", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    // Alternating: spawn, then a poll where it's running (absent from
    // `spawning`) but still desired, then dies and spawns again — 5 spawn
    // events spread across 10 polls, well inside the 60-minute window.
    for (let i = 0; i < 10; i++) {
      now = i * 5 * MIN;
      const spawningThisPoll = i % 2 === 0 ? ["S1"] : []; // alternates: spawn / (alive for a poll)
      await det.check(spawningThisPoll, ["S1"]); // "S1" is ALWAYS desired throughout
    }
    expect(chan.posted.length).toBe(1); // reached the threshold despite never appearing in `spawning` on odd polls
  });

  test("REGRESSION, against the WRONG pruning rule (keyed on 'absent from plan.spawn this poll' instead of 'desired'): the SAME alternating pattern above never reaches the threshold — this is the trap, demonstrated directly against a naive CrashLoopTracker usage", async () => {
    // Reproduces the wrong rule by calling `forgetMissing` with THIS POLL'S
    // `spawning` set (the naive, tempting shape) instead of `desired` — a
    // hand-rolled stand-in over the same CrashLoopTracker/recordSpawn API
    // this module's own `check` uses, isolating exactly the one line that
    // differs. If this test ever starts posting a complaint, the pruning
    // rule this file exists to pin has been silently reverted to the wrong
    // shape and this regression test caught it.
    const tracker = new CrashLoopTracker();
    let now = 0;
    const windowMs = 60 * MIN;
    let posts = 0;
    for (let i = 0; i < 10; i++) {
      now = i * 5 * MIN;
      const spawningThisPoll = i % 2 === 0 ? ["S1"] : [];
      tracker.forgetMissing(new Set(spawningThisPoll)); // THE BUG: keyed on `spawning`, not `desired`
      for (const id of spawningThisPoll) {
        const times = tracker.recordSpawn(id, now, windowMs);
        if (times.length >= 5) posts++;
      }
    }
    expect(posts).toBe(0); // FAILS against the correct pruning rule — this is the trap, reproduced
  });

  test("an id that leaves `desired` (ticket left the active states) is forgotten — a later, genuinely new episode starts a fresh floor and can alarm again", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 5; i++) { now = i * MIN; await det.check(["S1"], ["S1"]); }
    expect(chan.posted.length).toBe(1);

    now = 6 * MIN;
    await det.check([], []); // S1 left `desired` entirely — forgetMissing drops it

    // A fresh episode, well inside the SAME rolling hour as the first — if
    // tracking were not truly reset, the stale latch/adoption would matter
    // here; instead a fresh floor starts and needs its OWN 5 spawns.
    now = 7 * MIN;
    for (let i = 0; i < 4; i++) { now = 7 * MIN + i * MIN; await det.check(["S1"], ["S1"]); }
    expect(chan.posted.length).toBe(1); // only 4 so far this episode — not yet
    now = 11 * MIN;
    await det.check(["S1"], ["S1"]);
    // The 5th spawn of the NEW episode — findMarked adopts the FIRST
    // episode's still-present comment (same known, accepted limitation as
    // every other detector's fingerprint-only dedupe — see frozen-asleep.test.ts's
    // identical case) rather than posting a second one; the id is still
    // correctly reported (posted.length stays 1, not 0 — it was never silent).
    expect(chan.posted.length).toBe(1);
  });
});

describe("createCrashLoopDetector: THE INVERTED CONFIDENT-ZERO HAZARD (§6) — a fleet-wide 'nothing running' poll is not a fleet-wide crash loop", () => {
  test("when ALL of a multi-resource desired set is in plan.spawn on the same poll, none of it is counted toward any id's window — no comment, ever, across many such polls", async () => {
    let now = 0;
    const chan = fakeChannel();
    const logs: string[] = [];
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments, log: (l) => logs.push(l) });
    const desired = ["A", "B", "C"];
    for (let i = 0; i < 10; i++) {
      now = i * MIN;
      await det.check(desired, desired); // herdr reporting nothing running — ALL of desired lands in spawn
    }
    expect(chan.posted).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARNING: [crashloop]") && l.includes("not counted"))).toBe(true);
  });

  test("once the fleet-wide signal clears (not everything is spawning), per-id counting resumes normally and can still reach the threshold", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    const desired = ["A", "B", "C"];
    now = 0;
    await det.check(desired, desired); // fleet-wide — not counted
    // Now only "A" keeps crash-looping; B and C are running (absent from spawning).
    for (let i = 1; i <= 3; i++) {
      now = i * MIN;
      await det.check(["A"], desired);
    }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("A");
  });

  test("a SINGLE-resource fleet is never treated as fleet-wide (desired.length must exceed 1) — a real solo crash loop is still detectable", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 3; i++) { now = i * MIN; await det.check(["ONLY"], ["ONLY"]); }
    expect(chan.posted.length).toBe(1); // detected despite spawning.length === desired.length every time
  });

  test("a partial-fleet poll (some, not all, of desired is spawning) is never treated as fleet-wide", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 3; i++) { now = i * MIN; await det.check(["A"], ["A", "B"]); } // B is running; only A spawns
    expect(chan.posted.length).toBe(1);
  });
});

describe("createCrashLoopDetector: Rule 2a — 'could not check' must never take the same branch as 'checked, nothing found'", () => {
  test("a comments() fetch failure fails CLOSED: no post, no throw, and a later successful poll still posts", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fail = true;
    const logs: string[] = [];
    const det = createCrashLoopDetector({
      now: () => now, count: 5, windowMinutes: 60,
      addComment: chan.addComment,
      comments: async (id) => { if (fail) throw new Error("503"); return chan.comments(id); },
      log: (l) => logs.push(l),
    });
    for (let i = 0; i < 5; i++) { now = i * MIN; await det.check(["S1"], ["S1"]); }
    expect(chan.posted).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING: [crashloop]") && l.includes("comments fetch failed"))).toBe(true);

    fail = false;
    now = 5 * MIN;
    await det.check(["S1"], ["S1"]); // count is already >= 5 from the failed polls above; now succeeds
    expect(chan.posted.length).toBe(1);
  });

  test("a detector-internal throw (e.g. addComment rejects) is caught: check() never rejects", async () => {
    let now = 0;
    const det = createCrashLoopDetector({
      now: () => now, count: 5, windowMinutes: 60,
      addComment: async () => { throw new Error("boom"); },
      comments: async () => [],
    });
    for (let i = 0; i < 5; i++) { now = i * MIN; await expect(det.check(["S1"], ["S1"])).resolves.toBeUndefined(); }
  });
});

describe("createCrashLoopDetector: rate cap", () => {
  test("no more than 3 complaints per id per hour — a capped attempt is UNWRITTEN, retried once the window frees, not silently dropped", async () => {
    let now = 0;
    const chan = fakeChannel();
    const logs: string[] = [];
    // `comments` always reports empty — standing in for a real ticket busy
    // enough that this detector's own marker has scrolled off the page (same
    // reasoning frozen-asleep.test.ts's own rate-cap test states) — exercises
    // the cap itself, isolated from adoption.
    const det = createCrashLoopDetector({ now: () => now, count: 2, windowMinutes: 60, addComment: chan.addComment, comments: async () => [], log: (l) => logs.push(l) });
    for (let cycle = 0; cycle < 5; cycle++) {
      // Each cycle: 2 spawns (crosses the threshold, posts once), then the id
      // leaves `desired` (forgotten) so the NEXT cycle starts a fresh floor —
      // all within one rolling hour.
      now = cycle * 10 * MIN;
      await det.check(["S1"], ["S1"]);
      now = cycle * 10 * MIN + 1 * MIN;
      await det.check(["S1"], ["S1"]);
      now = cycle * 10 * MIN + 2 * MIN;
      await det.check([], []); // forget
    }
    expect(chan.posted.length).toBe(3); // capped at 3/hour even across 5 fresh episodes
    expect(logs.some((l) => l.startsWith("WARNING: [crashloop]") && l.includes("rate cap"))).toBe(true);
  });
});

describe("crashLoopComment: not answerable, and immune to the real parseDirective", () => {
  test("carries no ANSWER line and is never parsed as a directive by the real parser", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 3; i++) { now = i * MIN; await det.check(["BUTCHR-1"], ["BUTCHR-1"]); }
    const text = chan.posted[0]!.text;
    expect(/^\s*ANSWER /m.test(text)).toBe(false);
    expect(parseDirective(text)).toBeNull();
  });

  test("its marker is distinct from every other detector's marker in this codebase", () => {
    expect(MARKER).toBe("[butchr:crashloop]");
    expect(MARKER).not.toBe("[butchr:blocked]");
    expect(MARKER).not.toBe("[butchr:unresponsive]");
    expect(MARKER).not.toBe("[butchr:frozen]");
    expect(MARKER).not.toBe("[butchr:parked]");
  });
});

describe("createCrashLoopDetector: bracket-delimited dedupe anchor — a prefix id must not false-match", () => {
  test("BUTCHR-1's complaint is not adopted by BUTCHR-12's dedupe check, despite BUTCHR-1 being a textual prefix of BUTCHR-12", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    for (let i = 0; i < 3; i++) { now = i * MIN; await det.check(["BUTCHR-1"], ["BUTCHR-1"]); }
    expect(chan.posted.length).toBe(1);
    const text = chan.posted[0]!.text;
    // Simulate BUTCHR-1's complaint somehow ending up readable from BUTCHR-12's
    // own channel (defence in depth — this module's real `comments` is
    // scoped per-id in production, so this can't happen for real, but the
    // dedupe anchor itself must still not false-match if it ever did).
    const rows = [{ id: "x", body: text, created: new Date().toISOString() }];
    expect(findMarked(rows, MARKER, ["resource: [BUTCHR-12]"])).toBeNull();
    expect(findMarked(rows, MARKER, ["resource: [BUTCHR-1]"])?.id).toBe("x");
  });
});

describe("createCrashLoopDetector: works for a resource with NO ticket, via speakOnOwnChannel + createOwnChannelComments (acceptance criterion 3)", () => {
  test("END TO END: a project-tier crash-loop complaint round-trips through the REAL speakOnOwnChannel write and the REAL extracted createOwnChannelComments read-back", async () => {
    let now = 0;
    const pageComments: Array<{ id: string; body: string }> = [];
    const ops = makeOps({
      commentOnPage: async (_pageId: string, body: string) => {
        const id = String(1000 + pageComments.length);
        pageComments.push({ id, body });
        return { ok: true, id };
      },
      getPageComments: async () => ({ results: [...pageComments].reverse() }),
    });
    const comments = createOwnChannelComments(ops, async () => { throw new Error("must not be called for a project key"); });
    const addComment = async (id: string, text: string) => { await speakOnOwnChannel(ops, id, text); };

    const projectId = "BUTCHR";
    const before = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment, comments });
    for (let i = 0; i < 3; i++) { now = i * MIN; await before.check([projectId], [projectId]); }
    expect(pageComments.length).toBe(1); // posted for real, through the real wrap

    // Simulate a daemon restart: a brand-new detector, no in-memory tracking, same underlying channel.
    const after = createCrashLoopDetector({ now: () => now, count: 3, windowMinutes: 60, addComment, comments });
    for (let i = 0; i < 3; i++) { now = (i + 10) * MIN; await after.check([projectId], [projectId]); }
    expect(pageComments.length).toBe(1); // adopted via the real unwrap, not re-posted
  });
});

/** fakeHerd — same shape as loop.test.ts's/frozen-asleep.test.ts's, kept local so this file has no cross-file test fixture coupling. */
function fakeHerd(initial: string[] = [], stale: Array<{ issue: string; reason: string; observedArgv: string[] }> = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return stale.filter((s) => running.has(s.issue)); },
    async spawn(sp) { spawned.push(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

describe("reconcileNow: checkCrashLoop is called before the spawn loop, with (plan.spawn, desired.keys()), and NEVER affects plan.spawn/herd.spawn (§2.1/§2.3)", () => {
  test("checkCrashLoop is invoked with exactly this poll's plan.spawn and desired.keys(), and the actual herd.spawn calls are unaffected regardless of what it does", async () => {
    const herd = fakeHerd(["KEEP"]); // KEEP already running; NEW is desired-not-running
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const calls: Array<{ spawning: readonly string[]; desired: readonly string[] }> = [];
    await reconcileNow(herd, new Map([["KEEP", spec("KEEP")], ["NEW", spec("NEW")]]), {
      checkCrashLoop: async (spawning, desired) => { calls.push({ spawning: [...spawning], desired: [...desired] }); },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.spawning).toEqual(["NEW"]); // plan.spawn = desired - running
    expect(calls[0]!.desired.slice().sort()).toEqual(["KEEP", "NEW"]);
    expect(herd.spawned).toEqual(["NEW"]); // untouched by checkCrashLoop's own logic
  });

  test("checkCrashLoop runs BEFORE any herd.spawn call — speak-before-act ordering, even though this hook never gates a spawn", async () => {
    const order: string[] = [];
    const herd: Herd = {
      async runningIssues() { return []; },
      async staleIssues() { return []; },
      async spawn(sp) { order.push(`spawn:${sp.key}`); },
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    await reconcileNow(herd, new Map([["A", spec("A")]]), {
      checkCrashLoop: async () => { order.push("checkCrashLoop"); },
    });
    expect(order).toEqual(["checkCrashLoop", "spawn:A"]);
  });

  test("omitting checkCrashLoop entirely preserves ordinary reconcileNow behaviour, unchanged", async () => {
    const herd = fakeHerd([]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    await reconcileNow(herd, new Map([["A", spec("A")]]));
    expect(herd.spawned).toEqual(["A"]);
  });

  test("a crash-looping id, driven through the REAL reconcileNow over a fake Herd for 10 polls, is detected and posts exactly once — full integration, mirrors the ticket's own falsifier harness", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    // A crash-looping herd: spawn() never actually keeps the resource running.
    const herd: Herd = {
      async runningIssues() { return []; },
      async staleIssues() { return []; },
      async spawn() {},
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const desired = new Map([["BUTCHR-1", spec("BUTCHR-1")]]);
    for (let i = 0; i < 10; i++) {
      now = i * MIN;
      await reconcileNow(herd, desired, { checkCrashLoop: det.check });
    }
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("BUTCHR-1");
  });

  test("plan.spawn/herd.spawn are unaffected even when the detector alarms — the same 10-poll crash loop above spawns exactly 10 times, same as with no detector at all", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: chan.addComment, comments: chan.comments });
    const spawned: string[] = [];
    const herd: Herd = {
      async runningIssues() { return []; },
      async staleIssues() { return []; },
      async spawn(sp) { spawned.push(sp.key); },
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const desired = new Map([["BUTCHR-1", spec("BUTCHR-1")]]);
    for (let i = 0; i < 10; i++) {
      now = i * MIN;
      await reconcileNow(herd, desired, { checkCrashLoop: det.check });
    }
    expect(spawned.length).toBe(10); // identical to running with no checkCrashLoop at all — see loop.test.ts's own F2/F3 falsifier measurement
    expect(chan.posted.length).toBe(1); // and still alarmed
  });
});
