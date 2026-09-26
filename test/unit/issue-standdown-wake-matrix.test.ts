import { describe, expect, test } from "bun:test";
import { createIssueResourceType } from "../../src/resources/issue.js";
import { createStandDownRegistry } from "../../src/agents/stand-down.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import type { JiraIssue, IssueLink } from "../../src/atlassian/types.js";

/**
 * BUTCHR-298 (review of BUTCHR-307's PR, round 3) — THE WAKE MATRIX, pinned.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A DUPLICATE OF
 * `issue-standdown-loop.test.ts`: that file proves the mechanism works. This
 * one pins the exact SET of changes that do and do not wake a stood-down
 * agent, because `stand_down`'s own tool description and `briefs/epic.md`/
 * `briefs/story.md` now make that set a PROMISE to a reading agent — and the
 * first version of all three overpromised. They claimed "a daemon label
 * transition (including a pr:* review-state transition) ALWAYS wakes you,
 * unconditionally" on any watched ticket. The owning epic challenged that at
 * review of the story's own PR, asking for a test rather than an argument.
 * The test said the epic was right: a WORKER's label-only `pr:*` transition
 * does NOT wake its sleeping boss, because `crossDaemonSuppressed`
 * (src/resources/issue.ts) swallows a daemon-label-only diff with an unmoved
 * comment cursor BEFORE `finalize()` — the stand-down gate — ever runs.
 *
 * The behaviour is correct and deliberate: a worker's `agent:working` /
 * `agent:idle` labels flip constantly, and waking a boss for each would make
 * the whole feature worthless. The PROMISE was what was wrong. So this file
 * pins the matrix in both directions, so that prose and behaviour cannot
 * drift apart again without a test going red — the failure mode being that a
 * boss stands down expecting a wake it will never get and waits out the
 * maximum-sleep bound instead.
 *
 * Everything here drives the REAL `runResourceLoop` (real timers, a fake
 * `Herd`, the real `createIssueResourceType`) rather than hand-built
 * snapshots: the story's own first review probe re-implemented the loop's
 * related-ticket fetch inline and was therefore blind to the very defect it
 * was written to check. A fixture that is type-faithful but cannot express
 * the bug is worse than no fixture.
 */

const BOSS = "BUTCHR-900";
const WORKER = "BUTCHR-901";

const iss = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key,
  summary: `${key} summary`,
  status: "In Progress",
  issuetype: key === BOSS ? "Story" : "Task",
  labels: [],
  updated: "2026-09-11T00:00:00.000Z",
  issuelinks: [],
  ...over,
}) as JiraIssue;

const LINKS: Record<string, IssueLink[]> = {
  [BOSS]: [{ key: WORKER, type: "Implements", otherEnd: "outward" } as IssueLink],
  [WORKER]: [{ key: BOSS, type: "Implements", otherEnd: "inward" } as IssueLink],
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stands the boss down, then applies `mutate` to the Jira store and lets the
 * loop observe it. `comments` never moves, so every case here is a
 * comment-free change — which is the whole point: it isolates the
 * label/status/summary axes from the seen-set axis.
 */
async function bossSleepsThen(mutate: (store: Record<string, JiraIssue>) => void): Promise<{ asleepBefore: boolean; asleepAfter: boolean }> {
  const store: Record<string, JiraIssue> = {
    [BOSS]: iss(BOSS, { labels: ["agent:working", "pr:open"] }),
    [WORKER]: iss(WORKER, { labels: ["agent:working", "pr:open"] }),
  };
  const declared = new Set<string>();
  const sd = createStandDownRegistry({
    now: () => Date.now(),
    maxSleepMinutes: 60,
    yieldLoopCount: 5,
    yieldLoopWindowMinutes: 5,
    addComment: async () => {},
    comments: async () => [],
  });
  const resourceType = createIssueResourceType({
    search: async (jql: string) => {
      if (jql.startsWith("key IN")) {
        const keys = jql.slice(jql.indexOf("(") + 1, jql.lastIndexOf(")")).split(",").map((s) => s.trim());
        return keys.flatMap((k) => (store[k] ? [store[k]!] : []));
      }
      return [store[BOSS]!, store[WORKER]!];
    },
    links: async (k: string) => LINKS[k] ?? [],
    comments: async () => [{ id: "c1", body: "", created: "", authorEmail: null }],
    standDown: sd,
  });
  const running = new Set<string>();
  const stop = runResourceLoop(resourceType, {
    herd: {
      runningIssues: async () => [...running],
      staleIssues: async () => [],
      spawn: async (spec) => { running.add(spec.key); },
      stop: async (issue) => { running.delete(issue); },
      paneFor: async () => null,
      nudge: async () => ({ delivered: true }),
    },
    ownsId: () => true,
    notify: async () => {},
    checkDeclaredDone: async (restingRunning) => {
      const out = new Set<string>();
      for (const id of restingRunning) if (declared.delete(id)) out.add(id);
      return out;
    },
    invalidateDeclaredDone: (desired) => { for (const id of desired) declared.delete(id); },
    intervalMs: 40,
  });
  try {
    await wait(70);
    sd.standDown(BOSS, new Map([[BOSS, ["c1"]], [WORKER, ["c1"]]]));
    declared.add(BOSS);
    await wait(120);
    const asleepBefore = sd.isAsleep(BOSS);
    mutate(store);
    await wait(120);
    return { asleepBefore, asleepAfter: sd.isAsleep(BOSS) };
  } finally {
    stop();
  }
}

describe("the wake matrix a stood-down agent is PROMISED (stand_down's description, briefs/epic.md, briefs/story.md)", () => {
  test("DOES NOT wake: a worker's daemon-label-only pr:* transition, with no new comment — the promise the briefs used to make and no longer do", async () => {
    const { asleepBefore, asleepAfter } = await bossSleepsThen((store) => {
      store[WORKER] = { ...store[WORKER]!, labels: ["agent:working", "pr:approved"], updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    // If this ever goes red because the boss DID wake, the briefs and the
    // tool description must be widened back — do not weaken this assertion
    // to match a behaviour change nobody told an agent about.
    expect(asleepAfter).toBe(true);
  });

  test("DOES NOT wake: a worker's agent:* flip alone (the case that would make the whole feature worthless)", async () => {
    const { asleepBefore, asleepAfter } = await bossSleepsThen((store) => {
      store[WORKER] = { ...store[WORKER]!, labels: ["agent:idle", "pr:open"], updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(true);
  });

  test("WAKES: a worker's status change — the event a waiting boss actually cares about (reaching In Review)", async () => {
    const { asleepBefore, asleepAfter } = await bossSleepsThen((store) => {
      store[WORKER] = { ...store[WORKER]!, status: "In Review", updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(false);
  });

  test("WAKES: a worker's summary edit", async () => {
    const { asleepBefore, asleepAfter } = await bossSleepsThen((store) => {
      store[WORKER] = { ...store[WORKER]!, summary: "renamed by a human", updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(false);
  });

  test("WAKES: a pr:* transition on the sleeper's OWN ticket (the half of the label promise that IS true — prTransition is guarded by space === 'primary' && watcher === key)", async () => {
    const { asleepBefore, asleepAfter } = await bossSleepsThen((store) => {
      store[BOSS] = { ...store[BOSS]!, labels: ["agent:working", "pr:approved"], updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(false);
  });
});

// ===========================================================================
// FACTORY-39 (FACTORY-37): a Bug is a BOSS, the same tier as an Epic — its
// child Story reaching In Review must wake it exactly the way an Epic's
// child Story/Task does. The general classifier (src/resources/issue.ts)
// never reads `issuetype` (confirmed reading its own source for this
// ticket) — this is a Bug-specific instance of the SAME mechanism the
// matrix above already pins for Story/Task, not a parallel one, added as
// its own regression per this ticket's own acceptance criteria rather than
// relying on the generic claim alone.
// ===========================================================================

const BUG_BOSS = "BUTCHR-910";
const STORY_WORKER = "BUTCHR-911";

const bugIss = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key,
  summary: `${key} summary`,
  status: "In Progress",
  issuetype: key === BUG_BOSS ? "Bug" : "Story",
  labels: [],
  updated: "2026-09-11T00:00:00.000Z",
  issuelinks: [],
  ...over,
}) as JiraIssue;

const BUG_LINKS: Record<string, IssueLink[]> = {
  [BUG_BOSS]: [{ key: STORY_WORKER, type: "Implements", otherEnd: "outward" } as IssueLink],
  [STORY_WORKER]: [{ key: BUG_BOSS, type: "Implements", otherEnd: "inward" } as IssueLink],
};

async function bugSleepsThen(mutate: (store: Record<string, JiraIssue>) => void): Promise<{ asleepBefore: boolean; asleepAfter: boolean }> {
  const store: Record<string, JiraIssue> = {
    [BUG_BOSS]: bugIss(BUG_BOSS, { labels: ["agent:working", "pr:open"] }),
    [STORY_WORKER]: bugIss(STORY_WORKER, { labels: ["agent:working", "pr:open"] }),
  };
  const declared = new Set<string>();
  const sd = createStandDownRegistry({
    now: () => Date.now(),
    maxSleepMinutes: 60,
    yieldLoopCount: 5,
    yieldLoopWindowMinutes: 5,
    addComment: async () => {},
    comments: async () => [],
  });
  const resourceType = createIssueResourceType({
    search: async (jql: string) => {
      if (jql.startsWith("key IN")) {
        const keys = jql.slice(jql.indexOf("(") + 1, jql.lastIndexOf(")")).split(",").map((s) => s.trim());
        return keys.flatMap((k) => (store[k] ? [store[k]!] : []));
      }
      return [store[BUG_BOSS]!, store[STORY_WORKER]!];
    },
    links: async (k: string) => BUG_LINKS[k] ?? [],
    comments: async () => [{ id: "c1", body: "", created: "", authorEmail: null }],
    standDown: sd,
  });
  const running = new Set<string>();
  const stop = runResourceLoop(resourceType, {
    herd: {
      runningIssues: async () => [...running],
      staleIssues: async () => [],
      spawn: async (spec) => { running.add(spec.key); },
      stop: async (issue) => { running.delete(issue); },
      paneFor: async () => null,
      nudge: async () => ({ delivered: true }),
    },
    ownsId: () => true,
    notify: async () => {},
    checkDeclaredDone: async (restingRunning) => {
      const out = new Set<string>();
      for (const id of restingRunning) if (declared.delete(id)) out.add(id);
      return out;
    },
    invalidateDeclaredDone: (desired) => { for (const id of desired) declared.delete(id); },
    intervalMs: 40,
  });
  try {
    await wait(70);
    sd.standDown(BUG_BOSS, new Map([[BUG_BOSS, ["c1"]], [STORY_WORKER, ["c1"]]]));
    declared.add(BUG_BOSS);
    await wait(120);
    const asleepBefore = sd.isAsleep(BUG_BOSS);
    mutate(store);
    await wait(120);
    return { asleepBefore, asleepAfter: sd.isAsleep(BUG_BOSS) };
  } finally {
    stop();
  }
}

describe("FACTORY-39: a Bug boss wakes the same way an Epic/Story boss does", () => {
  test("WAKES: a child Story's status change to In Review — the event this ticket's own acceptance criteria names", async () => {
    const { asleepBefore, asleepAfter } = await bugSleepsThen((store) => {
      store[STORY_WORKER] = { ...store[STORY_WORKER]!, status: "In Review", updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(false);
  });

  test("WAKES: a summary edit on the Bug's own ticket", async () => {
    const { asleepBefore, asleepAfter } = await bugSleepsThen((store) => {
      store[BUG_BOSS] = { ...store[BUG_BOSS]!, summary: "renamed by a human", updated: "2026-09-11T02:00:00.000Z" };
    });
    expect(asleepBefore).toBe(true);
    expect(asleepAfter).toBe(false);
  });
});
