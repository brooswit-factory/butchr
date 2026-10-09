import { describe, expect, test } from "bun:test";
import { createIssueEventRules } from "../../src/resources/issue.js";
import { WAKE_MARKERS } from "../../src/jira-watch/diff.js";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";
import type { RelatedResource } from "../../src/resources/types.js";

/**
 * FACTORY-954: `decide()` (src/resources/issue.ts) must allowlist what a
 * RELATED (boss) watcher is ever notified about — before this ticket, the
 * general classifier delivered on any status transition, daemon-label
 * change, summary/assignee/description change, issuelinks diff, or any
 * comment id moving, so routine child activity (an In Progress poke, a
 * priority-only edit's leftover `updated` bump, an unrelated comment) woke
 * the boss just as loudly as a genuine status report. Table-driven per the
 * ticket's own TESTS section: every row shares one fixture shape (a
 * TASK/STORY pair, and separately a STORY/EPIC pair — `decide()` itself is
 * hop-agnostic, so the same assertions apply at either tier) and asserts
 * `deliver` for the immediate boss, `primary` space staying byte-identical,
 * and the same event never reaching past the immediate boss (there is no
 * second-tier watcher in `related` for a direct decide() call at all, so
 * this is demonstrated by the immediate-boss-only shape of every fixture
 * below, never by a second `decide()` call that could only be asked about
 * a watcher `related()` already excluded).
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

/** A routine human/agent comment, addressed to nobody in particular — the noise this ticket silences for `related`. */
const routineComment = (id: string) => row(id, "looks good, carrying on");

/** The exact shape `report_to_boss`/`ask_boss` (src/tools/relationship.ts's `tagComment`) produce: the ticket's OWN identity tag, nothing else required. */
const reportToBossComment = (key: string, id: string) => row(id, `[${key}] status update: still working this`);

/** `ask_boss`'s own shape — the identity tag, then ASK_MARKER (`[ask]`) right after it (src/tools/relationship.ts). Also matched by the plain self-tag check, so this is really the same signal as `reportToBossComment`, named separately to document that `ask_boss` needs no special-case. */
const askBossComment = (key: string, id: string) => row(id, `[${key}] [ask] can you confirm the approach before I continue?`);

const wakeMarkerComment = (marker: string, id: string) => row(id, `${marker} escalating to my boss`);

/**
 * One poll's worth of a boss watching a single related ticket, primed with
 * a baseline comment id `c0` on BOTH tickets (so the baseline-seeding
 * pre-pass has already run and the only comments() call `decide()` itself
 * can make is the one under test — mirrors every other suite in this
 * module's own sibling test files, e.g. issue-bookkeeping-comment-
 * suppression.test.ts).
 */
async function setupRelated(store: ReturnType<typeof commentStore>, bossKey: string, workerKey: string, workerBefore: JiraIssue, workerAfter: JiraIssue) {
  const rules = createIssueEventRules({ comments: store.comments });
  const bossIssue = issue({ key: bossKey });
  const relBefore: RelatedResource<JiraIssue> = { issue: workerBefore, watchers: [bossKey] };
  // Seed the baseline poll so commentCursor/pendingRecheck start clean.
  await rules.poll({ primary: [], related: [] }, { primary: [bossIssue], related: [relBefore] });
  const relAfter: RelatedResource<JiraIssue> = { issue: workerAfter, watchers: [bossKey] };
  const poll = await rules.poll({ primary: [bossIssue], related: [relBefore] }, { primary: [bossIssue], related: [relAfter] });
  return { rules, poll };
}

describe("FACTORY-954 table 1: a Task's routine comment never reaches its Story boss", () => {
  test("a plain, unaddressed comment on the Task -> nobody (related: false)", async () => {
    const store = commentStore({ "TASK-1": [row("c0", "baseline")], "STORY-1": [row("s0", "baseline")] });
    const before = issue({ key: "TASK-1", updated: "t0" });
    const after = issue({ key: "TASK-1", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    store.set("TASK-1", [routineComment("c1"), row("c0", "baseline")]);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict.deliver).toBe(false);
  });
});

describe("FACTORY-954 table 2: a Task's In Progress transition never reaches its Story boss", () => {
  test("In Progress -> In Progress (no-op) and any non-review/done status transition -> nobody", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", status: "To Do", updated: "t0" });
    const after = issue({ key: "TASK-1", status: "In Progress", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict.deliver).toBe(false);
  });
});

describe("FACTORY-954 table 3: a Task reaching In Review wakes its Story boss only", () => {
  test("status -> In Review delivers, named by status", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", status: "In Progress", updated: "t0" });
    const after = issue({ key: "TASK-1", status: "In Review", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
  });
});

describe("FACTORY-954 table 4: a Task reaching Done wakes its Story boss only", () => {
  test("status -> Done delivers, named by status", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", status: "In Review", updated: "t0" });
    const after = issue({ key: "TASK-1", status: "Done", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { status: { from: "In Review", to: "Done" } } });
  });
});

describe("FACTORY-954 table 5: a Task's worker->boss markers wake its Story boss only", () => {
  test("report_to_boss's own comment shape ([<key>] text, no further marker) delivers, named by comment", async () => {
    const store = commentStore({ "TASK-1": [row("c0", "baseline")] });
    const before = issue({ key: "TASK-1", updated: "t0" });
    const after = issue({ key: "TASK-1", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    store.set("TASK-1", [reportToBossComment("TASK-1", "c1"), row("c0", "baseline")]);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { comment: "c1" } });
  });

  test("ask_boss's [ask] comment delivers, named by comment", async () => {
    const store = commentStore({ "TASK-1": [row("c0", "baseline")] });
    const before = issue({ key: "TASK-1", updated: "t0" });
    const after = issue({ key: "TASK-1", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    store.set("TASK-1", [askBossComment("TASK-1", "c1"), row("c0", "baseline")]);
    const verdict = await poll.decide("TASK-1", "STORY-1", "related");
    expect(verdict).toEqual({ deliver: true, reason: { comment: "c1" } });
  });

  for (const marker of WAKE_MARKERS) {
    test(`${marker} delivers, named by comment`, async () => {
      const store = commentStore({ "TASK-1": [row("c0", "baseline")] });
      const before = issue({ key: "TASK-1", updated: "t0" });
      const after = issue({ key: "TASK-1", updated: "t1" });
      const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
      store.set("TASK-1", [wakeMarkerComment(marker, "c1"), row("c0", "baseline")]);
      const verdict = await poll.decide("TASK-1", "STORY-1", "related");
      expect(verdict).toEqual({ deliver: true, reason: { comment: "c1" } });
    });
  }
});

describe("FACTORY-954 table 6: routine non-comment diffs never reach the Story boss either", () => {
  test("a summary-only edit -> nobody", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", summary: "old", updated: "t0" });
    const after = issue({ key: "TASK-1", summary: "new", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("an assignee-only edit -> nobody", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", assignee: "a@x.com", updated: "t0" });
    const after = issue({ key: "TASK-1", assignee: "b@x.com", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("a description-only edit -> nobody", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", description: "old", updated: "t0" });
    const after = issue({ key: "TASK-1", description: "new", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("an issuelinks-only edit -> nobody", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", issuelinks: [], updated: "t0" });
    const after = issue({ key: "TASK-1", issuelinks: [{ type: "Implements", otherEnd: "inward", key: "OTHER-1" }], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  test("an agent:* daemon-label-only edit -> nobody (caught by pre-existing cross-daemon echo suppression, same as before this ticket)", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:working"], updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:idle"], updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });

  // A label transition that ESCAPES suppression (paired with a summary
  // change in the SAME diff — `isDaemonLabelOnlyDiff` is false whenever
  // `summary` also differs, so `crossDaemonSuppressed` returns `{suppressed:
  // false}` immediately and never even calls `fetchComments`) still reaches
  // the general classifier directly, which checks `label` BEFORE `summary`
  // (this module's own documented precedence) — so this is the one case
  // this ticket's own gate, not the pre-existing suppression stack, is what
  // actually blocks delivery for `related`. THE FACTORY-948/949 INTERACTION
  // (per FACTORY-954's own ticket comment): a sibling story is concurrently
  // carving an agent:*->agent:blocked transition out of suppression for
  // delivery on this exact edge; that carve-out is NOT present at this
  // ticket's base commit (grepped — see src/resources/issue.ts's own
  // `deliverToRelated` doc comment) so it is NOT specially allowed here
  // either, by design, until whichever of these two tickets lands second
  // reconciles with the other.
  test("a label transition that escapes suppression (paired with a summary change) still -> nobody for related — the classifier names it `label`, checked before `summary`", async () => {
    const store = commentStore();
    const before = issue({ key: "TASK-1", labels: ["agent:working"], summary: "old", updated: "t0" });
    const after = issue({ key: "TASK-1", labels: ["agent:idle"], summary: "new", updated: "t1" });
    const { poll } = await setupRelated(store, "STORY-1", "TASK-1", before, after);
    expect((await poll.decide("TASK-1", "STORY-1", "related")).deliver).toBe(false);
  });
});

describe("FACTORY-954 table 7: a Story's analogous events wake its Epic boss only — same decide(), one tier up", () => {
  test("a Story's routine comment -> nobody", async () => {
    const store = commentStore({ "STORY-1": [row("c0", "baseline")] });
    const before = issue({ key: "STORY-1", issuetype: "Story", updated: "t0" });
    const after = issue({ key: "STORY-1", issuetype: "Story", updated: "t1" });
    const { poll } = await setupRelated(store, "EPIC-1", "STORY-1", before, after);
    store.set("STORY-1", [routineComment("c1"), row("c0", "baseline")]);
    expect((await poll.decide("STORY-1", "EPIC-1", "related")).deliver).toBe(false);
  });

  test("a Story reaching In Review -> its Epic boss, named by status", async () => {
    const store = commentStore();
    const before = issue({ key: "STORY-1", issuetype: "Story", status: "In Progress", updated: "t0" });
    const after = issue({ key: "STORY-1", issuetype: "Story", status: "In Review", updated: "t1" });
    const { poll } = await setupRelated(store, "EPIC-1", "STORY-1", before, after);
    expect(await poll.decide("STORY-1", "EPIC-1", "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
  });

  test("a Story's own report_to_boss comment -> its Epic boss, named by comment", async () => {
    const store = commentStore({ "STORY-1": [row("c0", "baseline")] });
    const before = issue({ key: "STORY-1", issuetype: "Story", updated: "t0" });
    const after = issue({ key: "STORY-1", issuetype: "Story", updated: "t1" });
    const { poll } = await setupRelated(store, "EPIC-1", "STORY-1", before, after);
    store.set("STORY-1", [reportToBossComment("STORY-1", "c1"), row("c0", "baseline")]);
    expect(await poll.decide("STORY-1", "EPIC-1", "related")).toEqual({ deliver: true, reason: { comment: "c1" } });
  });
});

describe("FACTORY-954: primary space stays byte-identical — every reason this ticket restricts for `related` still delivers in full for `primary`", () => {
  const cases: Array<{ name: string; before: Partial<JiraIssue>; after: Partial<JiraIssue> }> = [
    { name: "In Progress transition", before: { status: "To Do" }, after: { status: "In Progress" } },
    { name: "summary change", before: { summary: "old" }, after: { summary: "new" } },
    { name: "assignee change", before: { assignee: "a@x.com" }, after: { assignee: "b@x.com" } },
    { name: "description change", before: { description: "old" }, after: { description: "new" } },
    {
      name: "issuelinks change",
      before: { issuelinks: [] },
      after: { issuelinks: [{ type: "Implements", otherEnd: "inward", key: "OTHER-1" }] },
    },
  ];
  for (const c of cases) {
    test(`${c.name} still delivers on primary`, async () => {
      const store = commentStore();
      const rules = createIssueEventRules({ comments: store.comments });
      const before = issue({ key: "TASK-1", updated: "t0", ...c.before });
      const after = issue({ key: "TASK-1", updated: "t1", ...c.after });
      const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
      expect((await poll.decide("TASK-1", "TASK-1", "primary")).deliver).toBe(true);
    });
  }

  test("a routine (non-boss-addressed) comment still delivers on primary (the worker always sees everything on its own ticket)", async () => {
    const store = commentStore({ "TASK-1": [row("c0", "baseline")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ key: "TASK-1", updated: "t0" });
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
    await seed.decide("TASK-1", "TASK-1", "primary");
    store.set("TASK-1", [routineComment("c1"), row("c0", "baseline")]);
    const after = issue({ key: "TASK-1", updated: "t1" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    expect((await poll.decide("TASK-1", "TASK-1", "primary")).deliver).toBe(true);
  });
});
