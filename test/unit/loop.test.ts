import { describe, expect, test } from "bun:test";
import { desiredFrom, reconcileNow, startLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

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
const iss = (key: string, status: string, parent: string | null = null): JiraIssue => ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent, updated: "t" });

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
    ({ issue: { key, status, summary: "s", issuetype: "Task", assignee: "other", parent: null, updated }, watchers });
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
