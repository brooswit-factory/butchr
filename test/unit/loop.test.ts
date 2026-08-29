import { describe, expect, test } from "bun:test";
import { desiredFrom, reconcileNow, startLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

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

  test("a stale-but-desired issue is stopped then spawned fresh, and onRespawn fires once with its reason + observed argv", async () => {
    const herd = fakeHerd(["STALE"], [{ issue: "STALE", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "abc"] }]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const calls: any[] = [];
    await reconcileNow(herd, new Map([["STALE", spec("STALE")]]), { onRespawn: (issue, reason, observedArgv) => { calls.push({ issue, reason, observedArgv }); } });
    expect(herd.stopped).toEqual(["STALE"]);
    expect(herd.spawned).toEqual(["STALE"]);
    expect(calls).toEqual([{ issue: "STALE", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "abc"] }]);
  });

  test("no onRespawn callback provided → stale issue still gets stopped and spawned", async () => {
    const herd = fakeHerd(["STALE"], [{ issue: "STALE", reason: "x", observedArgv: [] }]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    await reconcileNow(herd, new Map([["STALE", spec("STALE")]]));
    expect(herd.stopped).toEqual(["STALE"]);
    expect(herd.spawned).toEqual(["STALE"]);
  });

  // PR #68 review: HerdrHerd.spawn() now waits out KICKOFF_VERIFY_MS
  // (KAN-804/807) before resolving. A serial spawn loop over a burst of new
  // issues (several stories activating in one poll) would stall the entire
  // 15s poll — label sync and every ticket's notifications included — for N
  // times that wait. Prove they run concurrently instead: three spawns each
  // taking DELAY_MS finish in ~one DELAY_MS, not three.
  test("spawns a burst of new issues concurrently, not serially", async () => {
    const DELAY_MS = 30;
    const running = new Set<string>();
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp) { await new Promise((r) => setTimeout(r, DELAY_MS)); running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return true; },
    };
    const start = Date.now();
    await reconcileNow(herd, new Map([["A", spec("A")], ["B", spec("B")], ["C", spec("C")]]));
    const elapsed = Date.now() - start;
    expect([...running].sort()).toEqual(["A", "B", "C"]);
    expect(elapsed).toBeLessThan(DELAY_MS * 2); // well under 3x if they ran serially
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

describe("startLoop own-label-write nudge suppression", () => {
  test("the daemon's own label write bumping `updated` does not itself nudge; a real subsequent change still does", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],                                       // poll 0: baseline
      [{ ...iss("A", "In Progress"), updated: "t2" }],                  // poll 1: only `updated` bumped — our own write
      [{ ...iss("A", "In Review"), updated: "t3" }],                    // poll 2: a REAL change (status)
    ];
    const writes: Array<ReadonlySet<string>> = [new Set(["A"]), new Set(), new Set()];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      syncLabels: async () => { const w = writes[Math.min(n, writes.length - 1)]!; n++; return w; },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(notified.filter((x) => x === "A").length).toBe(1); // swallowed once (poll 1), nudged once (poll 2's real change)
  });

  test("a notifying (non-quiet) label write still gets exactly one own-write `updated` bump swallowed", async () => {
    // startLoop only sees the written-keys set syncLabels returns — it has no idea
    // whether the write behind it was quiet (notifyUsers=false) or notifying (KAN-801):
    // a notifying write bumps `updated` exactly the same way, so the swallow is unaffected.
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],
      [{ ...iss("A", "In Progress"), updated: "t2" }], // our own notifying write bumped `updated`
      [{ ...iss("A", "In Review"), updated: "t3" }],   // a real subsequent change
    ];
    const writes: Array<ReadonlySet<string>> = [new Set(["A"]), new Set(), new Set()];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      syncLabels: async () => { const w = writes[Math.min(n, writes.length - 1)]!; n++; return w; },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(notified.filter((x) => x === "A").length).toBe(1); // swallowed once, nudged once for the real change
  });

  test("a poll whose only change is the daemon's own label write produces no nudge at all", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],
      [{ ...iss("A", "In Progress"), updated: "t2" }],
    ];
    const writes: Array<ReadonlySet<string>> = [new Set(["A"]), new Set()];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      herd,
      notify: (i) => { notified.push(i); },
      syncLabels: async () => { const w = writes[Math.min(n, writes.length - 1)]!; n++; return w; },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toEqual([]);
  });
});

describe("startLoop respawn wiring", () => {
  test("deps.onRespawn is invoked through reconcileNow on each poll a stale agent is found", async () => {
    const herd = fakeHerd(["A"], [{ issue: "A", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "x"] }]);
    const respawns: any[] = [];
    const stop = startLoop({
      search: async () => [iss("A", "In Progress")],
      herd,
      notify: () => {},
      onRespawn: (issue, reason, observedArgv) => { respawns.push({ issue, reason, observedArgv }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(respawns[0]).toEqual({ issue: "A", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "x"] });
    expect(herd.stopped).toContain("A");
    expect(herd.spawned).toContain("A");
  });
});
