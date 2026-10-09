import { describe, expect, test } from "bun:test";
import { createIssueEventRules } from "../../src/resources/issue.js";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";
import type { RelatedResource } from "../../src/resources/types.js";

/**
 * FACTORY-972 (story FACTORY-971, extending FACTORY-949/951/964): the
 * `agent:stalled` twin of test/unit/related-space-notify-allowlist.test.ts's
 * "FACTORY-964: the blockedWake carve-out is folded into the related-space
 * allowlist as an explicit case" block — same fixtures, same template,
 * proving the stalled reason survives the REAL `decide()`/`deliverToRelated`
 * path (never a mock of `relatedAllows`) for a related (boss) watcher. This
 * is the exact gap FACTORY-971's own architecture correction exists to
 * close: a `stalledWake()` unit test returning `true` in isolation would
 * never have caught a missing `relatedAllows` case, because `relatedAllows`
 * defaults to deny and `stalledWake` never calls it itself.
 */

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "TASK-1",
  summary: "s",
  status: "In Progress",
  issuetype: "Task",
  assignee: null,
  parent: null,
  updated: "2026-01-01T00:00:00.000Z",
  labels: [],
  ...over,
});

function commentStore(seed: Record<string, JiraComment[]> = {}) {
  const byKey = new Map<string, JiraComment[]>(Object.entries(seed));
  return {
    set: (key: string, rows: JiraComment[]) => byKey.set(key, rows),
    comments: async (key: string): Promise<readonly JiraComment[]> => byKey.get(key) ?? [],
  };
}

const row = (id: string, body: string, created = "t"): JiraComment => ({ id, body, created, authorEmail: null });

async function setupRelated(store: ReturnType<typeof commentStore>, bossKey: string, workerKey: string, workerBefore: JiraIssue, workerAfter: JiraIssue, extraDeps: Parameters<typeof createIssueEventRules>[0] = {}) {
  const rules = createIssueEventRules({ comments: store.comments, ...extraDeps });
  const bossIssue = issue({ key: bossKey });
  const relBefore: RelatedResource<JiraIssue> = { issue: workerBefore, watchers: [bossKey] };
  await rules.poll({ primary: [], related: [] }, { primary: [bossIssue], related: [relBefore] });
  const relAfter: RelatedResource<JiraIssue> = { issue: workerAfter, watchers: [bossKey] };
  const poll = await rules.poll({ primary: [bossIssue], related: [relBefore] }, { primary: [bossIssue], related: [relAfter] });
  return { rules, poll };
}

describe("FACTORY-972: the stalledWake carve-out survives the real relatedAllows gate", () => {
  test("agent:working -> agent:stalled on the related edge wakes the immediate boss, named by `stalled`", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });
  });

  test("no agent:* label (none) -> agent:stalled on the related edge also wakes the immediate boss", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: [], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });
  });

  test("agent:blocked -> agent:stalled on the related edge also wakes the immediate boss", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:blocked"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });
  });

  test("agent:stalled -> agent:working (recovered) on the related edge stays silent — stalledTransition only fires moving INTO stalled", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("agent:idle -> agent:working (routine, never touching stalled) on the related edge stays silent", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:idle"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("a pr:* flip alongside an unchanged agent:* label stays silent on the related edge", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:working", "pr:open"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:working", "pr:approved"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("the SAME agent:*->agent:stalled transition on the primary edge never fires the stalled reason — stalledWake is gated to space===\"related\" only", async () => {
    const store = commentStore();
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t0" });
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
    await seed.decide("TASK-1", "TASK-1", "primary");
    const after = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t1" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("TASK-1", "TASK-1", "primary");
    expect(verdict.deliver).toBe(false);
    if (verdict.deliver) expect(verdict.reason).not.toEqual({ stalled: { key: "TASK-1" } });
  });

  // NOTE: "the stalled ticket's own watcher and siblings never woken" is
  // enforced one level UP from this module — `createRuleEventRules`'s own
  // `entry.watchers.includes(watcher)` check (src/rules/resource-type.ts),
  // never inside `createIssueEventRules.decide()` itself, which trusts its
  // caller to pass only a legitimate watcher (exactly as the pre-existing
  // `blocked` carve-out already does). See test/unit/rule-engine.test.ts's
  // "the boss learns a child's agent:stalled transition..." test for that
  // guarantee, exercised end-to-end through the real rule engine.

  test("a Story's agent:*->agent:stalled transition wakes its Epic boss too — same decide(), one tier up", async () => {
    const store = commentStore();
    const before = issue({ key: "STORY-1", issuetype: "Story", labels: ["agent:working"], updated: "t0" });
    const after = issue({ key: "STORY-1", issuetype: "Story", labels: ["agent:stalled"], updated: "t1" });
    const { poll } = await setupRelated(store, "EPIC-1", "STORY-1", before, after);
    const verdict = await poll.decide("STORY-1", "EPIC-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { stalled: { key: "STORY-1" } } });
  });

  test("debounce: a re-flip into stalled within the debounce window does not re-fire a second wake on the related edge (idle<->stalled flap = one event)", async () => {
    const store = commentStore();
    const rules = createIssueEventRules({ comments: store.comments, stalledWakeDebounceMinutes: 10 });
    const bossIssue = issue({ key: "STORY-1" });
    const idle = issue({ key: "TASK-1", labels: ["agent:idle"] });
    const stalled = issue({ key: "TASK-1", labels: ["agent:stalled"] });
    const relIdle = { issue: idle, watchers: ["STORY-1"] };
    const relStalled = { issue: stalled, watchers: ["STORY-1"] };
    await rules.poll({ primary: [], related: [] }, { primary: [bossIssue], related: [relIdle] });
    const firstPoll = await rules.poll({ primary: [bossIssue], related: [relIdle] }, { primary: [bossIssue], related: [relStalled] });
    const firstVerdict = await firstPoll.decide("TASK-1", "STORY-1", "related");
    expect(firstVerdict).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });

    // Flap: stalled -> idle -> stalled again, inside the debounce window.
    const secondPoll = await rules.poll({ primary: [bossIssue], related: [relStalled] }, { primary: [bossIssue], related: [relIdle] });
    expect((await secondPoll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
    const thirdPoll = await rules.poll({ primary: [bossIssue], related: [relIdle] }, { primary: [bossIssue], related: [relStalled] });
    expect((await thirdPoll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false); // same episode, inside the window
  });

  test("dedup: a [butchr:stall] marker already posted for this episode suppresses the related-edge wake too", async () => {
    const postedAt = new Date().toISOString();
    const store = commentStore({ "TASK-1": [row("m1", "[butchr:stall] TASK-1 has read agent:stalled, continuously, for 30 minute(s): ...", postedAt)] });
    const before = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:stalled"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  // item 4: the hourly rate cap — a NEW axis blockedWake has no equivalent
  // of. Keyed by the RECIPIENT (the boss's own watcher key), not by ticket:
  // two DIFFERENT tickets stalling for the SAME boss in the same window
  // must still hit the cap.
  describe("the hourly rate cap", () => {
    test("exceeding the cap counts and logs the excess, never delivers it", async () => {
      const store = commentStore();
      const capped: string[] = [];
      const delivered: string[] = [];
      const rules = createIssueEventRules({
        comments: store.comments,
        stalledWakeMaxPerHour: 1,
        onStalledWake: (r) => delivered.push(r),
        onStalledWakeCapped: (r) => capped.push(r),
      });
      const bossIssue = issue({ key: "STORY-1" });
      const working1 = issue({ key: "TASK-1", labels: ["agent:working"] });
      const stalled1 = issue({ key: "TASK-1", labels: ["agent:stalled"] });
      const working2 = issue({ key: "TASK-2", labels: ["agent:working"] });
      const stalled2 = issue({ key: "TASK-2", labels: ["agent:stalled"] });

      await rules.poll(
        { primary: [], related: [] },
        { primary: [bossIssue], related: [{ issue: working1, watchers: ["STORY-1"] }, { issue: working2, watchers: ["STORY-1"] }] },
      );

      const firstPoll = await rules.poll(
        { primary: [bossIssue], related: [{ issue: working1, watchers: ["STORY-1"] }, { issue: working2, watchers: ["STORY-1"] }] },
        { primary: [bossIssue], related: [{ issue: stalled1, watchers: ["STORY-1"] }, { issue: working2, watchers: ["STORY-1"] }] },
      );
      expect(await firstPoll.decide("TASK-1", "STORY-1", "related")).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });

      // A DIFFERENT ticket, same boss recipient, stalling right after —
      // the cap (1/hour) is already spent on TASK-1's wake.
      const secondPoll = await rules.poll(
        { primary: [bossIssue], related: [{ issue: stalled1, watchers: ["STORY-1"] }, { issue: working2, watchers: ["STORY-1"] }] },
        { primary: [bossIssue], related: [{ issue: stalled1, watchers: ["STORY-1"] }, { issue: stalled2, watchers: ["STORY-1"] }] },
      );
      const verdict = await secondPoll.decide("TASK-2", "STORY-1", "related");
      expect(verdict.deliver).toBe(false);
      expect(capped).toEqual(["STORY-1"]);
      expect(delivered).toEqual(["STORY-1"]);
    });

    test("different recipients each get their own cap budget", async () => {
      const store = commentStore();
      const capped: string[] = [];
      const rules = createIssueEventRules({ comments: store.comments, stalledWakeMaxPerHour: 1, onStalledWakeCapped: (r) => capped.push(r) });
      const workingA = issue({ key: "TASK-A", labels: ["agent:working"] });
      const stalledA = issue({ key: "TASK-A", labels: ["agent:stalled"] });
      const workingB = issue({ key: "TASK-B", labels: ["agent:working"] });
      const stalledB = issue({ key: "TASK-B", labels: ["agent:stalled"] });
      const bossA = issue({ key: "STORY-A" });
      const bossB = issue({ key: "STORY-B" });

      await rules.poll(
        { primary: [], related: [] },
        { primary: [bossA, bossB], related: [{ issue: workingA, watchers: ["STORY-A"] }, { issue: workingB, watchers: ["STORY-B"] }] },
      );
      const poll = await rules.poll(
        { primary: [bossA, bossB], related: [{ issue: workingA, watchers: ["STORY-A"] }, { issue: workingB, watchers: ["STORY-B"] }] },
        { primary: [bossA, bossB], related: [{ issue: stalledA, watchers: ["STORY-A"] }, { issue: stalledB, watchers: ["STORY-B"] }] },
      );
      expect(await poll.decide("TASK-A", "STORY-A", "related")).toEqual({ deliver: true, reason: { stalled: { key: "TASK-A" } } });
      // A DIFFERENT boss, same poll — its own 1/hour budget is untouched by STORY-A's.
      expect(await poll.decide("TASK-B", "STORY-B", "related")).toEqual({ deliver: true, reason: { stalled: { key: "TASK-B" } } });
      expect(capped).toEqual([]);
    });
  });
});
