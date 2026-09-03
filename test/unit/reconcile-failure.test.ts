import { describe, expect, test } from "bun:test";
import { createReconcileFailureDetector, ReconcileFailureTracker, MARKER } from "../../src/agents/reconcile-failure.js";
import { findMarked } from "../../src/agents/escalation-helper.js";
import { parseDirective } from "../../src/agents/escalate.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../../src/tools/speak.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import { createCrashLoopDetector } from "../../src/agents/crash-loop.js";
import type { Herd } from "../../src/agents/herd.js";

const MIN = 60_000;

/** A fake "own channel" comment store: addComment writes land here, newest-first — same shape crash-loop.test.ts's/frozen-asleep.test.ts's fakeChannel uses. */
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

/** Full AtlassianOps fake, for the real-write-path test — same shape crash-loop.test.ts/frozen-asleep.test.ts/speak.test.ts use. */
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
    updatePage: async () => ({ ok: true, version: 1 }),
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

describe("createReconcileFailureDetector: the threshold itself", () => {
  test("a SINGLE isolated failure (the transient one-poll blip) never posts, even if it never recurs", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("blip") }], ["S1"], ["S1"]);
    for (let i = 1; i <= 20; i++) {
      now = i * MIN;
      await det.check([], ["S1"], ["S1"]); // still desired, no further failure — recovered
    }
    expect(chan.posted).toEqual([]);
  });

  test("two failures within the window post one observational complaint naming the resource, the stage, the count, and carrying the actual error message", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("workspace.create failed") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    now = MIN;
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("workspace.create failed") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    expect(chan.posted.length).toBe(1);
    expect(chan.posted[0]!.target).toBe("BUTCHR-1");
    const text = chan.posted[0]!.text;
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("BUTCHR-1");
    expect(text).toContain("2 time(s)");
    expect(text).toContain("spawn");
    expect(text).toContain("workspace.create failed"); // the actual rejection message — the thing crash-loop.ts's own complaint cannot carry
    expect(text).toContain("resource: [BUTCHR-1]");
  });

  test("two failures spread further apart than the rolling window never post — the first ages out before the second lands", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    now = 20 * MIN; // well past the 15-minute window
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    expect(chan.posted).toEqual([]);
  });

  test("once posted, the id is latched: no further comments-fetch or post while it keeps failing, until it leaves `desired`", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fetches = 0;
    const det = createReconcileFailureDetector({
      now: () => now,
      addComment: chan.addComment,
      comments: async (id) => { fetches++; return chan.comments(id); },
    });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    now = MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    expect(chan.posted.length).toBe(1);
    const fetchesAfterFirstPost = fetches;
    for (let i = 2; i <= 10; i++) {
      now = i * MIN;
      await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    }
    expect(chan.posted.length).toBe(1); // no duplicate
    expect(fetches).toBe(fetchesAfterFirstPost); // no extra I/O once latched
  });

  test("an id that leaves `desired` is forgotten — a later, genuinely new failure episode starts a fresh floor", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    now = MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    expect(chan.posted.length).toBe(1);

    now = 2 * MIN;
    await det.check([], [], []); // S1 left desired entirely — forgetMissing drops it

    now = 3 * MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("y") }], ["S1"], ["S1"]); // fresh episode, 1st failure
    expect(chan.posted.length).toBe(1); // not yet — only one failure this episode
    now = 4 * MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("y") }], ["S1"], ["S1"]); // 2nd failure of the NEW episode
    // findMarked adopts the still-present first-episode comment rather than
    // posting a second one — same known/accepted limitation as crash-loop's
    // fingerprint-only dedupe (test/unit/crash-loop.test.ts's identical
    // case). The id is still correctly reported (posted.length stays 1, not 0).
    expect(chan.posted.length).toBe(1);
  });
});

describe("createReconcileFailureDetector: Rule 2a — 'could not check' must never take the same branch as 'checked, nothing found'", () => {
  test("a comments() fetch failure fails CLOSED: no post, no throw, and a later successful poll still posts", async () => {
    let now = 0;
    const chan = fakeChannel();
    let fail = true;
    const logs: string[] = [];
    const det = createReconcileFailureDetector({
      now: () => now,
      addComment: chan.addComment,
      comments: async (id) => { if (fail) throw new Error("503"); return chan.comments(id); },
      log: (l) => logs.push(l),
    });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    now = MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    expect(chan.posted).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING: [reconcile]") && l.includes("comments fetch failed"))).toBe(true);

    fail = false;
    now = 2 * MIN;
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]); // count already >= 2 from the failed-fetch polls above; now succeeds
    expect(chan.posted.length).toBe(1);
  });

  test("a detector-internal throw (e.g. addComment rejects) is caught: check() never rejects", async () => {
    let now = 0;
    const det = createReconcileFailureDetector({
      now: () => now,
      addComment: async () => { throw new Error("boom"); },
      comments: async () => [],
    });
    await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
    now = MIN;
    await expect(det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"])).resolves.toBeUndefined();
  });
});

describe("createReconcileFailureDetector: rate cap", () => {
  test("no more than 3 complaints per id per hour — a capped attempt is UNWRITTEN, retried once the window frees, not silently dropped", async () => {
    let now = 0;
    const chan = fakeChannel();
    const logs: string[] = [];
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: async () => [], log: (l) => logs.push(l) });
    for (let cycle = 0; cycle < 5; cycle++) {
      now = cycle * 10 * MIN;
      await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
      now = cycle * 10 * MIN + 1 * MIN;
      await det.check([{ id: "S1", stage: "spawn", error: new Error("x") }], ["S1"], ["S1"]);
      now = cycle * 10 * MIN + 2 * MIN;
      await det.check([], [], []); // forget — fresh floor next cycle
    }
    expect(chan.posted.length).toBe(3); // capped at 3/hour even across 5 fresh episodes
    expect(logs.some((l) => l.startsWith("WARNING: [reconcile]") && l.includes("rate cap"))).toBe(true);
  });
});

describe("reconcileFailureComment: not answerable, and immune to the real parseDirective", () => {
  test("carries no ANSWER line and is never parsed as a directive by the real parser", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("x") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    now = MIN;
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("x") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    const text = chan.posted[0]!.text;
    expect(/^\s*ANSWER /m.test(text)).toBe(false);
    expect(parseDirective(text)).toBeNull();
  });

  test("its marker is distinct from every other detector's marker in this codebase", () => {
    expect(MARKER).toBe("[butchr:reconcile]");
    expect(MARKER).not.toBe("[butchr:blocked]");
    expect(MARKER).not.toBe("[butchr:unresponsive]");
    expect(MARKER).not.toBe("[butchr:frozen]");
    expect(MARKER).not.toBe("[butchr:parked]");
    expect(MARKER).not.toBe("[butchr:crashloop]");
    expect(MARKER).not.toBe("[butchr:respawn]");
  });
});

describe("createReconcileFailureDetector: bracket-delimited dedupe anchor — a prefix id must not false-match", () => {
  test("BUTCHR-1's complaint is not adopted by BUTCHR-12's dedupe check, despite BUTCHR-1 being a textual prefix of BUTCHR-12", async () => {
    let now = 0;
    const chan = fakeChannel();
    const det = createReconcileFailureDetector({ now: () => now, addComment: chan.addComment, comments: chan.comments });
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("x") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    now = MIN;
    await det.check([{ id: "BUTCHR-1", stage: "spawn", error: new Error("x") }], ["BUTCHR-1"], ["BUTCHR-1"]);
    expect(chan.posted.length).toBe(1);
    const text = chan.posted[0]!.text;
    const rows = [{ id: "x", body: text, created: new Date().toISOString() }];
    expect(findMarked(rows, MARKER, ["resource: [BUTCHR-12]"])).toBeNull();
    expect(findMarked(rows, MARKER, ["resource: [BUTCHR-1]"])?.id).toBe("x");
  });
});

describe("createReconcileFailureDetector: works for a resource with NO ticket, via speakOnOwnChannel + createOwnChannelComments", () => {
  test("END TO END: a project-tier isolated-failure complaint round-trips through the REAL speakOnOwnChannel write and the REAL extracted createOwnChannelComments read-back", async () => {
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
    const before = createReconcileFailureDetector({ now: () => now, addComment, comments });
    await before.check([{ id: projectId, stage: "spawn", error: new Error("workspace.create failed") }], [projectId], [projectId]);
    now = MIN;
    await before.check([{ id: projectId, stage: "spawn", error: new Error("workspace.create failed") }], [projectId], [projectId]);
    expect(pageComments.length).toBe(1); // posted for real, through the real wrap

    // Simulate a daemon restart: a brand-new detector, no in-memory tracking, same underlying channel.
    const after = createReconcileFailureDetector({ now: () => now, addComment, comments });
    now = 10 * MIN;
    await after.check([{ id: projectId, stage: "spawn", error: new Error("workspace.create failed") }], [projectId], [projectId]);
    now = 11 * MIN;
    await after.check([{ id: projectId, stage: "spawn", error: new Error("workspace.create failed") }], [projectId], [projectId]);
    expect(pageComments.length).toBe(1); // adopted via the real unwrap, not re-posted
  });
});

describe("BUTCHR-147 §5 — the crash-loop overlap, MEASURED against the real reconcileNow + real createCrashLoopDetector", () => {
  /**
   * The ticket's own §5 finding, verified rather than trusted: a resource
   * whose spawn REJECTS every poll never becomes `running`, so it is in
   * `plan.spawn` on every poll — BUTCHR-141's crash-loop detector already
   * counts it and WILL post its own `[butchr:crashloop]` complaint once it
   * crosses ITS threshold (5 spawns/60min), independently of this module.
   * This is genuinely two DIFFERENT facts (crash-loop's is a pure count;
   * this module's carries the actual rejection message), so both are left
   * free to fire — neither suppresses nor defers to the other (see this
   * module's own top comment). This module's own threshold (2 failures/15min)
   * is deliberately faster, so an operator sees the actual error well before
   * crash-loop's hour-long window would otherwise be the only signal.
   */
  test("a persistently-rejecting spawn, driven through the REAL reconcileNow for 10 polls, is reported by BOTH detectors independently — reconcile-failure first, crash-loop later", async () => {
    let now = 0;
    const crashPosted: string[] = [];
    const reconcilePosted: string[] = [];
    const crashDet = createCrashLoopDetector({ now: () => now, count: 5, windowMinutes: 60, addComment: async (_id, text) => { crashPosted.push(text); }, comments: async () => [] });
    const reconcileDet = createReconcileFailureDetector({ now: () => now, addComment: async (_id, text) => { reconcilePosted.push(text); }, comments: async () => [] });
    const herd: Herd = {
      async runningIssues() { return []; },
      async staleIssues() { return []; },
      async spawn() { throw new Error("workspace.create failed"); },
      async stop() {},
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    const desired = new Map([["BUTCHR-1", { key: "BUTCHR-1", issuetype: "Task", summary: "s", parent: null }]]);
    let reconcileFiredAtPoll = -1;
    let crashFiredAtPoll = -1;
    for (let i = 0; i < 10; i++) {
      now = i * 60_000;
      await reconcileNow(herd, desired, { checkCrashLoop: crashDet.check, checkReconcileFailure: reconcileDet.check });
      if (reconcileFiredAtPoll === -1 && reconcilePosted.length) reconcileFiredAtPoll = i;
      if (crashFiredAtPoll === -1 && crashPosted.length) crashFiredAtPoll = i;
    }
    expect(reconcilePosted.length).toBe(1);
    expect(crashPosted.length).toBe(1);
    expect(reconcilePosted[0]).toContain("workspace.create failed"); // crash-loop's own complaint cannot carry this
    expect(crashPosted[0]).not.toContain("workspace.create failed");
    expect(reconcileFiredAtPoll).toBeLessThan(crashFiredAtPoll); // reconcile-failure surfaces first, by design
  });
});

describe("BUTCHR-147 review fix (PR #204 round 1) — a persistently-failing herd.stop now reaches the threshold and speaks", () => {
  /**
   * MEASURED ON THE PRE-FIX CODE (the reviewer's own probe): pruning keyed
   * on `desired` alone deleted a stop-failure's entry every poll — a
   * `plan.stop` id is NEVER in `desired` (`stop = running − desired − atRest`,
   * src/reconcile/plan.ts) — so the count was pinned at 1 forever and
   * `THRESHOLD_COUNT` (2) was unreachable. Ten consecutive polls produced
   * zero complaints. Falsifier stated before running THIS test, on the fixed
   * code: if a persistently-failing herd.stop still does NOT post within 10
   * polls, the fix is wrong. This drives the REAL `reconcileNow`, not
   * `check` directly — a direct-`check` test is what hid the defect
   * originally, because it always passed the failing id inside `desired`.
   */
  test("a persistently-rejecting herd.stop, driven through the REAL reconcileNow for 10 polls, posts exactly once, at poll 2", async () => {
    let now = 0;
    const posted: string[] = [];
    const det = createReconcileFailureDetector({ now: () => now, addComment: async (_id, text) => { posted.push(text); }, comments: async () => [] });
    // OLD-1: running, never desired — plan.stop every poll — and its
    // herd.stop() always throws, so it stays running (never actually
    // stopped) on every subsequent poll too, exactly like the reviewer's
    // own ARM A probe.
    const herd: Herd = {
      async runningIssues() { return ["OLD-1"]; },
      async staleIssues() { return []; },
      async spawn() {},
      async stop() { throw new Error("herdr stop refused: pane busy"); },
      async paneFor() { return null; },
      async nudge() { return { delivered: true }; },
    };
    const desired = new Map<string, { key: string; issuetype: string; summary: string; parent: null }>();
    let firedAtPoll = -1;
    for (let i = 0; i < 10; i++) {
      now = i * 60_000;
      await reconcileNow(herd, desired, { checkReconcileFailure: det.check });
      if (firedAtPoll === -1 && posted.length) firedAtPoll = i;
    }
    expect(posted.length).toBe(1);
    expect(firedAtPoll).toBe(1); // 0-indexed: the 2nd poll is where the 2nd failure crosses THRESHOLD_COUNT
    expect(posted[0]).toContain("OLD-1");
    expect(posted[0]).toContain("stop");
    expect(posted[0]).toContain("herdr stop refused: pane busy");
  });
});

describe("ReconcileFailureTracker", () => {
  test("recordFailure prunes to the rolling window and forgetMissing drops ids missing from the union it's given", () => {
    const tracker = new ReconcileFailureTracker();
    const t1 = tracker.recordFailure("A", "spawn", "e1", 0, 15 * MIN);
    expect(t1).toEqual([0]);
    const t2 = tracker.recordFailure("A", "spawn", "e2", 20 * MIN, 15 * MIN); // outside the 15-minute window from t=0
    expect(t2).toEqual([20 * MIN]);
    tracker.markSpoken("A", 20 * MIN);
    expect(tracker.isSpoken("A")).toBe(true);
    tracker.forgetMissing(new Set());
    expect(tracker.isSpoken("A")).toBe(false); // forgotten entirely
  });

  test("REVIEW FIX (PR #204 round 1): an id absent from `desired` but present in `running` (a plan.stop candidate) SURVIVES forgetMissing across polls, so its failure count can actually accumulate", () => {
    const tracker = new ReconcileFailureTracker();
    tracker.recordFailure("OLD-1", "stop", "e1", 0, 15 * MIN);
    // Old (broken) call would have been forgetMissing(new Set(desired)) with
    // desired = [] here, which deletes "OLD-1" and resets it to zero. The
    // fixed call unions in `running`, where "OLD-1" (running, undesired) still
    // is every poll it keeps failing to stop.
    tracker.forgetMissing(new Set([...[], ...["OLD-1"]]));
    const t2 = tracker.recordFailure("OLD-1", "stop", "e2", MIN, 15 * MIN);
    expect(t2.length).toBe(2); // NOT reset to 1 — this is exactly what PR #204's review round 1 caught
  });
});
