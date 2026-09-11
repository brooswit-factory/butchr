import { describe, expect, test } from "bun:test";
import { createIssueEventRules, createIssueResourceType, ISSUE_ACTIVATION } from "../../src/resources/issue.js";
import { createStandDownRegistry } from "../../src/agents/stand-down.js";
import { createCrashLoopDetector } from "../../src/agents/crash-loop.js";
import { desiredFrom, atRestFrom } from "../../src/daemon/loop.js";
import { mapAgentStatus } from "../../src/labels/plan.js";
import { StalledTracker } from "../../src/agents/stalled.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { RelatedResource } from "../../src/resources/types.js";

const MIN = 60_000;

/**
 * BUTCHR-307 DoD item 3: demonstrated end-to-end through the REAL event
 * rules (`createIssueEventRules`/`createIssueResourceType`, never a
 * hand-rolled fixture asserting a private helper), the same discipline
 * test/unit/project-self-wake-loop.test.ts already uses for the project
 * tier. Each describe block states its own failure condition first.
 */

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "KAN-1",
  summary: "s",
  status: "In Progress",
  issuetype: "Task",
  assignee: null,
  parent: null,
  updated: "2026-01-01T00:00:00.000Z",
  labels: [],
  ...over,
});

/** A tiny in-memory comment store, keyed by ticket, newest-first — enough for `deps.comments` and the stand-down registry's own reads. */
function commentStore(seed: Record<string, string[]> = {}) {
  const byKey = new Map<string, string[]>(Object.entries(seed));
  return {
    set: (key: string, ids: string[]) => byKey.set(key, ids),
    comments: async (key: string) => (byKey.get(key) ?? []).map((id) => ({ id, body: "", created: "", authorEmail: null })),
  };
}

function newRegistry(now: () => number = () => 0) {
  return createStandDownRegistry({
    now,
    maxSleepMinutes: 60,
    yieldLoopCount: 5,
    yieldLoopWindowMinutes: 5,
    addComment: async () => {},
    comments: async () => [],
  });
}

describe("BUTCHR-307 DoD 3(a): a comment on the issue's own ticket wakes it", () => {
  test("an unseen comment id, appearing since stand-down, wakes the sleeping primary watcher", async () => {
    const store = commentStore({ "KAN-1": ["100"] });
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    const rules = createIssueEventRules({ comments: store.comments, standDown: sd });

    const before = issue({ updated: "2026-01-01T00:00:00.000Z" });
    // A new comment lands — nothing structural changes, only `updated` moves (the real shape a comment write produces).
    const after = issue({ updated: "2026-01-01T00:05:00.000Z" });
    store.set("KAN-1", ["100", "101"]);

    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    expect(poll.changedPrimary).toEqual(["KAN-1"]); // `updated` moved -> a real change

    expect(sd.isAsleep("KAN-1")).toBe(true); // sanity: still asleep before this decide()
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(sd.isAsleep("KAN-1")).toBe(false); // woken
  });
});

describe("BUTCHR-307 DoD 3(b): a change on a WORKER's ticket wakes its stood-down boss", () => {
  test("an unseen comment on a related (worker) ticket wakes the boss watching it, not the worker itself", async () => {
    const store = commentStore({ "KAN-2": ["200"] });
    const sd = newRegistry();
    // The boss (KAN-1) stood down watching both its own ticket and its current worker, KAN-2.
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]], ["KAN-2", ["200"]]]));
    const rules = createIssueEventRules({ comments: store.comments, standDown: sd });

    const workerBefore = issue({ key: "KAN-2", updated: "2026-01-01T00:00:00.000Z" });
    const workerAfter = issue({ key: "KAN-2", updated: "2026-01-01T00:05:00.000Z" });
    store.set("KAN-2", ["200", "201"]); // a new, unseen comment on the worker's ticket

    const relBefore: RelatedResource<JiraIssue> = { issue: workerBefore, watchers: ["KAN-1"] };
    const relAfter: RelatedResource<JiraIssue> = { issue: workerAfter, watchers: ["KAN-1"] };
    const poll = await rules.poll({ primary: [], related: [relBefore] }, { primary: [], related: [relAfter] });
    expect(poll.changedRelated).toEqual(["KAN-2"]);

    const verdict = await poll.decide("KAN-2", "KAN-1", "related");
    expect(verdict.deliver).toBe(true);
    expect(sd.isAsleep("KAN-1")).toBe(false); // the BOSS woke, not some other id
  });
});

describe("BUTCHR-307 DoD 3(f): the agent's OWN last writes (report_to_boss/tell_worker), followed by stand_down, do not wake it — INCLUDING a foreign write landing in the same poll window", () => {
  test("own-comment-only diff (updated moved, nothing structural) with the comment already in the stand-down snapshot: gated, does not wake", async () => {
    // Mirrors the measured incident: a `tell_worker` comment lands, and a
    // FOREIGN write (this daemon never made) bumps `updated` in the same
    // window, defeating the own-write ledger's exact-match suppression —
    // modeled here by simply not wiring `suppress` at all (nothing ever
    // suppresses at the ledger layer), so decide() reaches this module's own
    // gate exactly as it would after that ledger race.
    const store = commentStore({ "KAN-1": ["100", "101"] }); // the agent's own last-act comment (101) is ALREADY on the ticket
    const sd = newRegistry();
    // stand_down runs AFTER the agent's own report_to_boss/tell_worker write, so its snapshot already includes comment 101.
    sd.standDown("KAN-1", new Map([["KAN-1", ["100", "101"]]]));
    const rules = createIssueEventRules({ comments: store.comments, standDown: sd });

    const before = issue({ updated: "2026-01-01T00:00:00.000Z" });
    const after = issue({ updated: "2026-01-01T00:05:00.000Z" }); // the foreign write's own `updated` bump — no status/label/summary diff at all

    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    expect(poll.changedPrimary).toEqual(["KAN-1"]);

    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(false); // no unseen comment id -> gated
    expect(sd.isAsleep("KAN-1")).toBe(true); // still asleep — never woken
  });

  test("a pr:* review-state transition wakes unconditionally, with no comment involved and no seen-set check at all (contrast case)", async () => {
    // Contrast: a pr:* transition is NOT something stand_down's own last-act
    // writes (comments) can ever produce, and createIssueEventRules delivers
    // it BEFORE ever consulting suppression or the seen-set (the primary
    // self-watch branch, ahead of appear/disappear and `suppressed()`) — the
    // cleanest structural case, proving the gate only narrows the comment/
    // no-reason shapes, never this one.
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]])); // fully caught up on the comment axis — irrelevant here
    const rules = createIssueEventRules({ standDown: sd }); // no `comments` dep at all: this path makes no comments() call

    const before = issue({ labels: ["pr:open"] });
    const after = issue({ labels: ["pr:approved"], updated: "2026-01-01T00:05:00.000Z" });

    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(sd.isAsleep("KAN-1")).toBe(false); // structural -> unconditional wake, even with nothing unseen on the comment axis
  });
});

describe("BUTCHR-307: a rejected comments() call while asleep fails TOWARD waking, never toward silently staying asleep", () => {
  test("a comments() rejection on the unseen-check path wakes the watcher rather than treating the fetch failure as 'nothing unseen'", async () => {
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    const rules = createIssueEventRules({
      comments: async () => { throw new Error("transient Jira failure"); },
      standDown: sd,
    });
    const before = issue({ updated: "2026-01-01T00:00:00.000Z" });
    const after = issue({ updated: "2026-01-01T00:05:00.000Z" }); // only `updated` moved — no structural diff
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true); // cannot verify "nothing new" -> wakes rather than risks a silent lost wake
    expect(sd.isAsleep("KAN-1")).toBe(false);
  });
});

describe("BUTCHR-307 DoD 3(e): nothing wakes when nothing happened", () => {
  test("an identical (prev, next) snapshot pair produces no changed keys at all — decide() is never even consulted", async () => {
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    const rules = createIssueEventRules({ standDown: sd });
    const same = issue();
    const poll = await rules.poll({ primary: [same], related: [] }, { primary: [same], related: [] });
    expect(poll.changedPrimary).toEqual([]);
    expect(poll.changedRelated).toEqual([]);
    expect(sd.isAsleep("KAN-1")).toBe(true); // still asleep — nothing to wake it
  });
});

describe("BUTCHR-307: a watcher with NO recorded baseline for a key fails TOWARD waking, never silently swallows", () => {
  test("a worker created AFTER the boss stood down (no baseline for it) wakes the boss on its first change", async () => {
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]])); // KAN-3 did not exist yet at stand-down time
    const rules = createIssueEventRules({ standDown: sd });
    const workerBefore = issue({ key: "KAN-3" });
    const workerAfter = issue({ key: "KAN-3", updated: "2026-01-01T00:05:00.000Z" });
    const poll = await rules.poll(
      { primary: [], related: [{ issue: workerBefore, watchers: ["KAN-1"] }] },
      { primary: [], related: [{ issue: workerAfter, watchers: ["KAN-1"] }] },
    );
    const verdict = await poll.decide("KAN-3", "KAN-1", "related");
    expect(verdict.deliver).toBe(true);
    expect(sd.isAsleep("KAN-1")).toBe(false);
  });
});

describe("BUTCHR-307: reconcile level — asleep is excluded from `desired` but protected via `atRest`, exactly like the project tier", () => {
  test("createIssueResourceType's discovery.search() stamps .asleep from the registry; desiredFrom excludes it, atRestFrom includes it", async () => {
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    const resourceType = createIssueResourceType({
      search: async () => [issue({ key: "KAN-1" }), issue({ key: "KAN-2" })],
      links: async () => [],
      standDown: sd,
    });
    const issues = await resourceType.discovery.search();
    const k1 = issues.find((i) => i.key === "KAN-1")!;
    expect(k1.asleep).toBe(true);
    expect(ISSUE_ACTIVATION.verdictFor(k1)).toBe("asleep");

    const desired = desiredFrom(issues, resourceType);
    expect(desired.has("KAN-1")).toBe(false); // never re-spawned while asleep
    expect(desired.has("KAN-2")).toBe(true); // an ordinary active issue is unaffected

    const atRest = atRestFrom(issues, resourceType);
    expect(atRest.has("KAN-1")).toBe(true); // protects a currently-running pane through the wake-then-exit race
  });

  test("the lost-wake bound: an issue asleep past the configured maximum is force-woken by discovery.search() itself, on the very poll that crosses the bound", async () => {
    let now = 0;
    const sd = createStandDownRegistry({
      now: () => now,
      maxSleepMinutes: 60,
      yieldLoopCount: 5,
      yieldLoopWindowMinutes: 5,
      addComment: async () => {},
      comments: async () => [],
    });
    sd.standDown("KAN-1", new Map());
    const resourceType = createIssueResourceType({
      search: async () => [issue({ key: "KAN-1" })],
      links: async () => [],
      standDown: sd,
    });
    now = 59 * MIN;
    let issues = await resourceType.discovery.search();
    expect(issues[0]!.asleep).toBe(true); // still within the bound

    now = 60 * MIN;
    issues = await resourceType.discovery.search();
    expect(issues[0]!.asleep).toBeFalsy(); // force-woken THIS poll, not one poll later
    expect(sd.isAsleep("KAN-1")).toBe(false);
  });

  test("forgetMissing bound: an issue that leaves the active JQL result set entirely is forgotten, not left tracked forever", async () => {
    const sd = newRegistry();
    sd.standDown("KAN-1", new Map([["KAN-1", ["100"]]]));
    const resourceType = createIssueResourceType({
      search: async () => [], // KAN-1 no longer active at all — e.g. it reached Done
      links: async () => [],
      standDown: sd,
    });
    await resourceType.discovery.search();
    expect(sd.isAsleep("KAN-1")).toBe(false);
    expect(sd.hasBaseline("KAN-1", "KAN-1")).toBe(false);
  });
});

describe("BUTCHR-307 DoD 3(d): a stood-down issue is structurally unreachable for `stalled` — verified, not merely asserted", () => {
  test("mapAgentStatus(null) (no live herdr agent) reads 'none', and StalledTracker never accrues a streak on 'none'", () => {
    expect(mapAgentStatus(null)).toBe("none");
    const tracker = new StalledTracker(() => 0, 10);
    expect(tracker.observe("KAN-1", "none")).toBe(false);
  });

  test("a long run of 'none' observations never becomes a stalled candidate, unlike an equally long run of 'idle'", () => {
    let now = 0;
    const tracker = new StalledTracker(() => now, 10);
    for (let i = 0; i <= 20; i++) {
      now = i * MIN;
      expect(tracker.observe("KAN-1", "none")).toBe(false);
    }
    // Contrast: the same elapsed time with 'idle' instead DOES become a candidate — proving 'none' isn't merely "not yet".
    const idleTracker = new StalledTracker(() => now, 10);
    now = 0;
    idleTracker.observe("KAN-2", "idle");
    now = 11 * MIN;
    expect(idleTracker.observe("KAN-2", "idle")).toBe(true);
  });
});

describe("BUTCHR-307 DoD 4: a wake-from-stand_down spawn must never reach the crash-loop detector's candidate list — call-site fix, detector untouched", () => {
  test("five wake/stand_down cycles for the same id, each consumed as an exemption before the crash-loop check runs, never trip the detector", async () => {
    let now = 0;
    const sd = createStandDownRegistry({
      now: () => now,
      maxSleepMinutes: 60,
      yieldLoopCount: 100, // isolate this test from the yield-loop bound itself
      yieldLoopWindowMinutes: 60,
      addComment: async () => {},
      comments: async () => [],
    });
    const posted: string[] = [];
    const crashLoop = createCrashLoopDetector({
      now: () => now,
      count: 3,
      windowMinutes: 60,
      addComment: async (_id, text) => { posted.push(text); },
      comments: async () => [],
    });
    // The exact composition src/daemon/index.ts wires at the issue loop's `checkCrashLoop` call site.
    const checkCrashLoop = (spawning: readonly string[], desired: readonly string[]) =>
      crashLoop.check(sd.consumeCrashLoopExemptions(spawning), desired);

    for (let i = 0; i < 5; i++) {
      now = i * MIN;
      sd.standDown("KAN-1", new Map());
      await sd.wake("KAN-1", "edge"); // an orderly wake — sets the one-shot exemption
      await checkCrashLoop(["KAN-1"], ["KAN-1"]); // this poll's spawn candidate is the wake-driven respawn
    }
    expect(posted).toEqual([]); // never reported as a crash loop

    // Contrast: an UNDECLARED respawn (no stand_down/wake at all) of the same
    // shape genuinely trips the SAME detector — proving this is a call-site
    // filter, not a detector that has quietly stopped working.
    now = 100 * MIN;
    for (let i = 0; i < 3; i++) {
      now = 100 * MIN + i * MIN;
      await checkCrashLoop(["KAN-2"], ["KAN-2"]); // never exempted — a real, undeclared respawn
    }
    expect(posted.length).toBe(1);
  });
});
