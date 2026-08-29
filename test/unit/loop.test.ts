import { describe, expect, test } from "bun:test";
import { desiredFrom, reconcileNow, startLoop } from "../../src/daemon/loop.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return true; },
  };
}
const iss = (key: string, status: string, parent: string | null = null): JiraIssue => ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent, updated: "t", labels: [] });

describe("reconcileNow", () => {
  test("spawns active-not-running and stops running-not-active", async () => {
    const herd = fakeHerd(["OLD", "KEEP"]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    await reconcileNow(herd, new Map([["KEEP", spec("KEEP")], ["NEW", spec("NEW")]]));
    expect(herd.spawned).toEqual(["NEW"]);
    expect(herd.stopped).toEqual(["OLD"]);
    expect([...herd.running].sort()).toEqual(["KEEP", "NEW"]);
  });
});

describe("startLoop: parent is membership only — never notified", () => {
  test("a changed child notifies its own agent only; its parent is NOT notified", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("KAN-1", "In Progress"), iss("KAN-2", "In Progress", "KAN-1")],
      [iss("KAN-1", "In Progress"), iss("KAN-2", "In Review", "KAN-1")],   // child changed
    ];
    let n = 0;
    const stop = startLoop({ search: async () => polls[Math.min(n++, 1)]!, herd, notify: (i) => { notified.push(i); }, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("KAN-2");       // the child
    expect(notified).not.toContain("KAN-1");   // its parent is membership only — not notified
  });
});

describe("startLoop", () => {
  test("reconciles each poll and notifies on change; stop() ends it", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress"), iss("B", "To Do")],                    // baseline: A active → spawn A
      [iss("A", "In Progress"), iss("B", "In Review")],                // B now active → spawn B; B changed → notify
      [iss("A", "Done"), iss("B", "In Review")],                       // A done → stop A; A changed → notify
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(herd.spawned).toContain("A");
    expect(herd.spawned).toContain("B");
    expect(herd.stopped).toContain("A");     // shut off when it left the active states
    expect(notified).toContain("B");
    expect(notified).toContain("A");
    const before = notified.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(notified.length).toBe(before);    // stopped
  });
});

describe("startLoop related-work watch", () => {
  const rel = (key: string, status: string, watchers: string[], updated = "t") =>
    ({ issue: { key, status, summary: "s", issuetype: "Task", assignee: "other", parent: null, updated, labels: [] }, watchers });
  test("a changed related ticket notifies each watcher, naming what changed", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const activeSeen: string[][] = [];
    const assigned = [iss("KAN-1", "In Progress")];
    const relatedPolls = [
      [rel("KAN-9", "In Progress", ["KAN-1"])],
      [rel("KAN-9", "In Review", ["KAN-1"])],       // the (cross-account) child moved
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => assigned,
      related: async (active) => { activeSeen.push([...active]); return relatedPolls[Math.min(n++, 1)]!; },
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(activeSeen[0]).toEqual(["KAN-1"]);            // related() is fed the active set
    expect(notified).toContain("KAN-1<-KAN-9");          // watcher woken, told what changed
    expect(notified).not.toContain("KAN-9<-KAN-9");      // the related ticket itself is not ours to nudge
  });
  test("a newly filed child counts as a change; watcher+about pairs are deduped", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const assigned = [iss("KAN-1", "In Progress")];
    const relatedPolls: ReturnType<typeof rel>[][] = [
      [],
      [rel("KAN-9", "To Do", ["KAN-1"])],               // child appears
      [rel("KAN-9", "To Do", ["KAN-1"])],               // …and holds still
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => assigned,
      related: async () => relatedPolls[Math.min(n++, 2)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(notified.filter((x) => x === "KAN-1<-KAN-9").length).toBe(1);
  });
});

describe("startLoop related-work watch: same-daemon boss/implementer", () => {
  const rel = (key: string, status: string, watchers: string[], updated = "t") =>
    ({ issue: { key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated, labels: [] }, watchers });
  test("boss B and implementer I both active on this daemon: I changing notifies B about I, and I about itself exactly once", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    // B (a story) and I (its task) are both in the assigned/active set — the
    // gap this closes: I used to be skipped out of `related` entirely
    // because it was already in `keys`, so B never heard about it.
    const assignedPolls = [
      [iss("B", "In Progress"), iss("I", "In Progress")],
      [iss("B", "In Progress"), iss("I", "In Review")],   // I changed
    ];
    const relatedPolls = [
      [rel("I", "In Progress", ["B"])],
      [rel("I", "In Review", ["B"])],       // I changed
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => assignedPolls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("B<-I");                                  // boss notified about its implementer
    expect(notified.filter((x) => x === "I<-I").length).toBe(1);         // I's own agent notified about itself exactly once (sent dedupe)
  });

  test("mirror: B changing does NOT notify I", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("B", "In Progress"), iss("I", "In Progress")],
      [iss("B", "In Review"), iss("I", "In Progress")],   // B changed
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, 1)]!,
      related: async () => [rel("I", "In Progress", ["B"])],
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("B<-B");        // B's own agent hears its own change
    expect(notified).not.toContain("I<-B");    // I never hears about its boss through this link
  });
});

describe("startLoop own-write ledger suppression (Part A)", () => {
  test("a self-write alone produces no nudge; two self-writes in a row still produce none; a real subsequent change still does", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],                                       // poll 0: baseline, updated "t"
      [{ ...iss("A", "In Progress"), updated: "t2" }],                  // poll 1: self-write #1
      [{ ...iss("A", "In Progress"), updated: "t3" }],                  // poll 2: self-write #2
      [{ ...iss("A", "In Review"), updated: "t4" }],                    // poll 3: a REAL change — never recorded
    ];
    ledger.record("A", "t2", "A", Date.now());
    ledger.record("A", "t3", "A", Date.now());
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(notified.filter((x) => x === "A").length).toBe(1); // both self-writes swallowed; poll 3's real change delivered
  });

  test("a self-write and a foreign change landing in the same poll window (updated moves past the recorded value) is delivered", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],
      // Our own write was recorded for "t2", but by the time this poll ran,
      // a foreign comment had ALSO landed, pushing `updated` to "t3" — a
      // value that matches nothing in the ledger, so it must be delivered.
      [{ ...iss("A", "In Progress"), updated: "t3" }],
    ];
    ledger.record("A", "t2", "A", Date.now());
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("A");
  });

  test("an agent's write on its own ticket suppresses that agent alone; a watcher (via Implements) still hears it", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    const relOf = (updated: string) => [{ issue: { key: "T", status: "In Progress", summary: "s", issuetype: "Task", assignee: "a", parent: null, updated, labels: [] }, watchers: ["S"] }];
    const polls: JiraIssue[][] = [
      [iss("S", "In Progress"), iss("T", "In Progress")],
      [iss("S", "In Progress"), { ...iss("T", "In Progress"), updated: "t2" }],
    ];
    const relatedPolls = [relOf("t"), relOf("t2")];
    ledger.record("T", "t2", "T", Date.now());
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).not.toContain("T<-T"); // suppressed for the writer itself
    expect(notified).toContain("S<-T");     // its boss still hears it — this IS how "merged, over to you" arrives
  });

  test("a daemon label write on a story suppresses it for the story's own agent AND its epic watcher; a foreign comment in the same poll is delivered to both", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    const relOf = (updated: string) => [{ issue: { key: "S", status: "In Progress", summary: "s", issuetype: "Story", assignee: "a", parent: null, updated, labels: [] }, watchers: ["E"] }];
    const polls: JiraIssue[][] = [
      [iss("S", "In Progress")],
      [{ ...iss("S", "In Progress"), updated: "t2" }],  // daemon label write
      [{ ...iss("S", "In Progress"), updated: "t3" }],  // foreign comment
    ];
    const relatedPolls = [relOf("t"), relOf("t2"), relOf("t3")];
    ledger.record("S", "t2", DAEMON_WRITER, Date.now());
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(notified.filter((x) => x === "S<-S").length).toBe(1); // poll 1 (daemon write) suppressed; poll 2 (real) delivered
    expect(notified.filter((x) => x === "E<-S").length).toBe(1); // same for the epic watcher
  });
});

describe("startLoop cross-daemon label-only echo (A6)", () => {
  const story = (labels: string[], updated: string, status = "In Progress", summary = "s"): JiraIssue =>
    ({ key: "S", status, summary, issuetype: "Story", assignee: "a", parent: null, updated, labels });
  const relOf = (labels: string[], updated: string, status = "In Progress", summary = "s") =>
    [{ issue: story(labels, updated, status, summary), watchers: ["E"] }];
  const oneComment = (id: string): JiraComment[] => [{ id, body: "x", created: "c" }];

  test("a label-only daemon-namespaced diff with no recorded comment baseline is delivered (fail-safe), and exactly one comments() call is made", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return oneComment("5"); };
    const polls = [[story(["agent:working"], "t")], [story(["agent:idle"], "t2")]];
    const relatedPolls = [relOf(["agent:working"], "t"), relOf(["agent:idle"], "t2")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("S<-S");
    expect(notified).toContain("E<-S");
    expect(commentCalls).toBe(1);
  });

  test("a repeat label-only diff with no new comment (matches the recorded baseline) is suppressed for the ticket's agent and its watcher", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return oneComment("5"); }; // same newest id every time
    const polls = [[story(["agent:working"], "t")], [story(["agent:idle"], "t2")], [story(["agent:working"], "t3")]];
    const relatedPolls = [relOf(["agent:working"], "t"), relOf(["agent:idle"], "t2"), relOf(["agent:working"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // poll 1 (t2): unknown baseline -> delivered, baseline recorded as "5"
    // poll 2 (t3): baseline "5", newest still "5" -> no new comment -> suppressed
    expect(notified.filter((x) => x === "S<-S").length).toBe(1);
    expect(notified.filter((x) => x === "E<-S").length).toBe(1);
    expect(commentCalls).toBe(2);
  });

  test("a label-only diff whose newest comment id is newer than the recorded baseline is delivered", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const responses = [oneComment("5"), oneComment("6")];
    let commentCalls = 0;
    const comments = async () => { const r = responses[Math.min(commentCalls, 1)]!; commentCalls++; return r; };
    const polls = [[story(["agent:working"], "t")], [story(["agent:idle"], "t2")], [story(["agent:working"], "t3")]];
    const relatedPolls = [relOf(["agent:working"], "t"), relOf(["agent:idle"], "t2"), relOf(["agent:working"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // poll 1: unknown baseline -> delivered, baseline "5". poll 2: newest "6" != baseline "5" -> delivered.
    expect(notified.filter((x) => x === "S<-S").length).toBe(2);
    expect(notified.filter((x) => x === "E<-S").length).toBe(2);
  });

  test("a diff touching a non-daemon (human) label is not treated as a daemon write: delivered normally, no comments() call", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return oneComment("5"); };
    const polls = [[story(["agent:working"], "t")], [story(["agent:working", "urgent"], "t2")]];
    const relatedPolls = [relOf(["agent:working"], "t"), relOf(["agent:working", "urgent"], "t2")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("S<-S");
    expect(notified).toContain("E<-S");
    expect(commentCalls).toBe(0);
  });

  test("a status change alongside a label change is delivered normally, and the extra comments() call is NOT made", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return oneComment("5"); };
    const polls = [[story(["agent:working"], "t", "In Progress")], [story(["agent:idle"], "t2", "In Review")]];
    const relatedPolls = [relOf(["agent:working"], "t", "In Progress"), relOf(["agent:idle"], "t2", "In Review")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("S<-S");
    expect(notified).toContain("E<-S");
    expect(commentCalls).toBe(0); // the extra call belongs only to the label-only branch
  });

  test("a rejected comments() call fails OPEN: delivered (not suppressed), and does not corrupt the comment baseline for the next poll", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    // poll 1: comments() rejects (transient network error) -> must still deliver
    // poll 2: comments() succeeds with an unknown baseline (poll 1 never
    // recorded one) -> still delivers, per the unknown-baseline fail-safe
    const comments = async () => {
      commentCalls++;
      if (commentCalls === 1) throw new Error("503 unavailable");
      return oneComment("5");
    };
    const polls = [[story(["agent:working"], "t")], [story(["agent:idle"], "t2")], [story(["agent:working"], "t3")]];
    const relatedPolls = [relOf(["agent:working"], "t"), relOf(["agent:idle"], "t2"), relOf(["agent:working"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // Both label-only polls delivered: poll 1 despite the rejection, poll 2
    // because the failed poll never wrote a baseline (still unknown).
    expect(notified.filter((x) => x === "S<-S").length).toBe(2);
    expect(notified.filter((x) => x === "E<-S").length).toBe(2);
  });

  test("an appearing/disappearing key is never checked against the label-only rule at all: no comments() call, always delivered", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return oneComment("5"); };
    const polls = [[story(["agent:working"], "t")], []]; // S disappears from the feed
    const relatedPolls: ReturnType<typeof relOf>[] = [relOf(["agent:working"], "t"), []];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, 1)]!,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("S<-S");
    expect(notified).toContain("E<-S"); // the watcher hears the disappearance too — never checked against the label-only rule
    expect(commentCalls).toBe(0);
  });
});

describe("startLoop own-write ledger: appear/disappear bypasses suppression entirely", () => {
  test("a disappearing key is never checked against the ledger with a stale `updated` — always delivered even if that stale value happens to match a recorded write", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    // A self-write was recorded for "t" (A's ORIGINAL updated) — if the
    // suppression check ran on the stale previous value after A disappears,
    // this would wrongly match and suppress a real, informative change.
    ledger.record("A", "t", "A", Date.now());
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")], // updated "t" — matches the ledger entry above
      [],                        // A disappears
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("A"); // disappearing is still a real change — delivered regardless
  });
});

describe("startLoop task->story delivery (Part B, pinned)", () => {
  test("a task's change reaches its boss and only its boss: watchers = [story] notifies the story, never the epic", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const assigned = [iss("KAN-STORY", "In Progress")];
    // The task (implementer) is watched only by its story — routes.ts never
    // puts the epic in a task's watcher list (see test/unit/routes.test.ts);
    // this pins the loop-level consequence of that routing decision.
    const relatedPolls = [
      [{ issue: { key: "KAN-TASK", status: "In Progress", summary: "s", issuetype: "Task", assignee: "other", parent: "KAN-EPIC", updated: "t", labels: [] }, watchers: ["KAN-STORY"] }],
      [{ issue: { key: "KAN-TASK", status: "In Review", summary: "s", issuetype: "Task", assignee: "other", parent: "KAN-EPIC", updated: "t2", labels: [] }, watchers: ["KAN-STORY"] }],
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => assigned,
      related: async () => relatedPolls[Math.min(n++, 1)]!,
      herd,
      notify: (i, about) => { notified.push(`${i}<-${about}`); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("KAN-STORY<-KAN-TASK");
    expect(notified).not.toContain("KAN-EPIC<-KAN-TASK");
  });
});
