import { describe, expect, test } from "bun:test";
import { desiredFrom, reconcileNow, startLoop, RespawnGuard, scopedHerd } from "../../src/daemon/loop.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";

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
    async nudge() { return { delivered: true }; },
  };
}
const iss = (key: string, status: string, parent: string | null = null): JiraIssue => ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent, updated: "t", labels: [] });

/**
 * BUTCHR-91 review fix, regression test: `scopedHerd` must work over a REAL
 * `HerdrHerd` class instance, not just the plain object literals every
 * other `Herd` fixture in this file (and every other test file) uses.
 *
 * WHY A PLAIN OBJECT WOULD NOT CATCH THIS (the control the review asked
 * for): on a plain object literal, `spawn`/`stop`/`nudge`/`paneFor` are OWN
 * enumerable properties, so `{ ...plainHerd, runningIssues, staleIssues }`
 * copies them straight through — object spread "works". `HerdrHerd`
 * defines those same members as CLASS METHODS, which live on the
 * prototype, not on the instance — object spread copies only an instance's
 * OWN enumerable properties (`herdr`/`mcpUrl`/`wait` here), never anything
 * inherited from its prototype. So the exact same spread expression
 * silently produces a fully-working herd from a plain object and a
 * herd with `spawn`/`stop`/`nudge`/`paneFor` all `undefined` from a real
 * `HerdrHerd` — a defect invisible to any test (or to TypeScript, which
 * checks against the declared `Herd` INTERFACE, not an object's runtime
 * enumerability) built only on plain-object fixtures. MEASURED, both
 * directions, below.
 */
describe("scopedHerd (BUTCHR-91/BUTCHR-68) — must preserve a REAL HerdrHerd's methods, not just plain-object fixtures", () => {
  test("negative control: the naive `{ ...herd, ... }` spread drops a real HerdrHerd's spawn/stop/nudge/paneFor", () => {
    const real = new HerdrHerd({} as never, "http://x/mcp");
    const naiveSpread = { ...real, runningIssues: real.runningIssues, staleIssues: real.staleIssues } as unknown as Herd;
    expect(typeof naiveSpread.spawn).toBe("undefined");
    expect(typeof naiveSpread.stop).toBe("undefined");
    expect(typeof naiveSpread.nudge).toBe("undefined");
    expect(typeof naiveSpread.paneFor).toBe("undefined");
  });

  test("scopedHerd's actual (explicit-delegation) implementation preserves every method of a real HerdrHerd instance", () => {
    const real = new HerdrHerd({} as never, "http://x/mcp");
    const scoped = scopedHerd(real, () => true);
    expect(typeof scoped.spawn).toBe("function");
    expect(typeof scoped.stop).toBe("function");
    expect(typeof scoped.nudge).toBe("function");
    expect(typeof scoped.paneFor).toBe("function");
    expect(typeof scoped.runningIssues).toBe("function");
    expect(typeof scoped.staleIssues).toBe("function");
  });

  test("scopedHerd's filtering still applies: runningIssues()/staleIssues() are scoped to ownsId, even over a real HerdrHerd instance", async () => {
    const real = new HerdrHerd({ agent: { list: async () => ({ agents: [{ name: "butchr-task-1", pane_id: "p1" }, { name: "butchr-proj1", pane_id: "p2" }] }) } } as never, "http://x/mcp");
    const scoped = scopedHerd(real, (id) => id.startsWith("TASK"));
    expect(await scoped.runningIssues()).toEqual(["TASK-1"]);
  });
});

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
      async nudge() { return { delivered: true }; },
    };
    const start = Date.now();
    await reconcileNow(herd, new Map([["A", spec("A")], ["B", spec("B")], ["C", spec("C")]]));
    const elapsed = Date.now() - start;
    expect([...running].sort()).toEqual(["A", "B", "C"]);
    expect(elapsed).toBeLessThan(DELAY_MS * 2); // well under 3x if they ran serially
  });
});

describe("reconcileNow storm guard (RespawnGuard)", () => {
  test("an issue that stays stale across many consecutive polls is respawned ONCE, then suppressed, with the WARNING logged and exactly ONE [butchr:respawn] notice for the window — then a NEW window opens once RESPAWN_SUPPRESS_POLLS have passed", async () => {
    // Same fake issue "stale" on every poll, forever — the shape a genuinely
    // broken/misbehaving agent would produce, and exactly what the OLD code
    // would have respawned every 15s, killing a healthy agent each time
    // (measured on KAN-811, CHANGELOG). One RespawnGuard instance threaded
    // through every call, standing in for the ONE instance startLoop creates
    // and keeps alive across its polls.
    const herd = fakeHerd(["A"], [{ issue: "A", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "x"] }]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const desired = new Map([["A", spec("A")]]);
    const guard = new RespawnGuard();
    const notices: Array<{ issue: string; reason: string; observedArgv: string[] }> = [];
    const warnings: string[] = [];
    const poll = () => reconcileNow(herd, desired, {
      guard,
      onRespawn: (issue, reason, observedArgv) => { notices.push({ issue, reason, observedArgv }); },
      onSuppressed: (_issue, message) => { warnings.push(message); },
    });

    await poll(); // poll 1: respawned — the window opens
    for (let i = 0; i < 4; i++) await poll(); // polls 2-5: still stale, still inside the 5-poll window — suppressed

    expect(herd.stopped).toEqual(["A"]);       // exactly one stop across all 5 polls
    expect(herd.spawned).toEqual(["A"]);       // exactly one spawn across all 5 polls
    expect(notices.length).toBe(1);            // exactly ONE [butchr:respawn]-worthy notice for the window
    expect(notices[0]!.issue).toBe("A");
    expect(warnings.length).toBe(4);           // logged on every suppressed poll (2-5)
    for (const w of warnings) {
      expect(w).toBe("WARNING: [reconcile] A respawned again within 5 polls — suppressing further respawns until poll 6");
    }

    await poll(); // poll 6: RESPAWN_SUPPRESS_POLLS have now passed — a fresh window, a real second respawn
    expect(herd.stopped).toEqual(["A", "A"]);
    expect(herd.spawned).toEqual(["A", "A"]);
    expect(notices.length).toBe(2);
    expect(warnings.length).toBe(4);           // no new warning on the poll that actually respawns
  });

  test("a fresh RespawnGuard (the reconcileNow default) never suppresses — each direct call starts un-suppressed", async () => {
    const herd = fakeHerd(["A"], [{ issue: "A", reason: "x", observedArgv: [] }]);
    const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });
    const desired = new Map([["A", spec("A")]]);
    const warnings: string[] = [];
    // No `guard` passed — each call gets its OWN fresh guard, so nothing ever suppresses.
    for (let i = 0; i < 3; i++) {
      await reconcileNow(herd, desired, { onSuppressed: (_issue, message) => warnings.push(message) });
    }
    expect(herd.stopped).toEqual(["A", "A", "A"]);
    expect(herd.spawned).toEqual(["A", "A", "A"]);
    expect(warnings).toEqual([]);
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

  test("a notifying (non-quiet) label write still gets exactly one own-write `updated` bump swallowed", async () => {
    // The ledger records the daemon's own label write by the `updated` it read
    // back, and knows nothing about whether that write was quiet
    // (notifyUsers=false) or notifying (KAN-801) — a notifying write bumps
    // `updated` exactly the same way, so the swallow is unaffected.
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    ledger.record("A", "t2", DAEMON_WRITER, Date.now());
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],
      [{ ...iss("A", "In Progress"), updated: "t2" }], // our own notifying write bumped `updated`
      [{ ...iss("A", "In Review"), updated: "t3" }],   // a real subsequent change
    ];
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
    expect(notified.filter((x) => x === "A").length).toBe(1); // swallowed once, nudged once for the real change
  });

  test("a poll whose only change is the daemon's own label write produces no nudge at all", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    const ledger = createOwnWriteLedger();
    ledger.record("A", "t2", DAEMON_WRITER, Date.now());
    const polls: JiraIssue[][] = [
      [iss("A", "In Progress")],
      [{ ...iss("A", "In Progress"), updated: "t2" }],
    ];
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
    expect(notified).toEqual([]);
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
  const oneComment = (id: string): JiraComment[] => [{ id, body: "x", created: "c", authorEmail: null }];

  test("a label-only daemon-namespaced diff on a key's first sighting is suppressed by the KAN-828 seed (seeding wins the race for a baseline before this branch ever sees 'unknown'), still exactly one comments() call", async () => {
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
    // KAN-828: this is S's first sighting AND its first label-only diff, in
    // the SAME poll. Baseline seeding runs first, records "5" from the same
    // memoized comments() call this branch then consults — so it finds a
    // real baseline that matches, not an unknown one, and correctly
    // suppresses rather than delivering an echo right after this key first
    // appears. See the "newer than the recorded baseline" test below for the
    // branch's fail-safe still firing when a real change follows.
    expect(notified).not.toContain("S<-S");
    expect(notified).not.toContain("E<-S");
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
    // KAN-828: poll 1 (t2) is S's first sighting AND first label-only diff —
    // baseline seeding records "5" before this branch consults it, so it
    // already finds a real (matching) baseline and suppresses, same as
    // poll 2 (t3): baseline "5", newest still "5" -> no new comment -> suppressed.
    expect(notified.filter((x) => x === "S<-S").length).toBe(0);
    expect(notified.filter((x) => x === "E<-S").length).toBe(0);
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
    // KAN-828: poll 1 is S's first sighting — baseline seeding records "5"
    // before this branch consults it, so it suppresses (matching baseline)
    // rather than delivering on "unknown". poll 2: newest "6" != baseline "5" -> delivered.
    expect(notified.filter((x) => x === "S<-S").length).toBe(1);
    expect(notified.filter((x) => x === "E<-S").length).toBe(1);
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
    // KAN-828: baseline seeding calls comments() once for S's first sighting
    // regardless of what kind of diff it is — this diff isn't label-only
    // (isDaemonLabelOnlyDiff is false, "urgent" isn't daemon-owned), so
    // crossDaemonSuppressed itself never calls comments(), but seeding does.
    expect(commentCalls).toBe(1);
  });

  test("a status change alongside a label change is delivered normally, and crossDaemonSuppressed itself makes no extra call (only baseline seeding does)", async () => {
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
    // KAN-828: isDaemonLabelOnlyDiff is false here (status also changed), so
    // crossDaemonSuppressed's OWN branch never calls comments() — but
    // baseline seeding still does, once, for S's first sighting.
    expect(commentCalls).toBe(1);
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
    // poll 1 delivers despite the rejection (fail-open) — both baseline
    // seeding and this branch share the same rejected memoized call, so the
    // cursor is left unset. KAN-828: poll 2's baseline seeding RETRIES (still
    // unseeded) and this time succeeds ("5"), recording it before this
    // branch consults it in the SAME poll — so poll 2 now finds a real,
    // matching baseline and suppresses, rather than delivering on "unknown"
    // as it did pre-KAN-828.
    expect(notified.filter((x) => x === "S<-S").length).toBe(1);
    expect(notified.filter((x) => x === "E<-S").length).toBe(1);
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

describe("startLoop: a pr:* transition wakes the ticket's own agent past both suppressions (KAN-691/819/823)", () => {
  const withPr = (labels: string[], updated: string, status = "In Progress"): JiraIssue =>
    ({ key: "K", status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated, labels });
  const relK = (labels: string[], updated: string, status = "In Progress") =>
    [{ issue: withPr(labels, updated, status), watchers: ["W"] }];

  test("ledger path: notified exactly once with a reason naming open->approved, even though the own-write ledger would suppress it; identical next poll notifies zero more; a watcher of K is not notified", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [
      [withPr(["agent:working", "pr:open"], "t1")],
      [withPr(["agent:working", "pr:approved"], "t2")],
      [withPr(["agent:working", "pr:approved"], "t2")], // identical repeat
    ];
    const relatedPolls = [
      relK(["agent:working", "pr:open"], "t1"),
      relK(["agent:working", "pr:approved"], "t2"),
      relK(["agent:working", "pr:approved"], "t2"),
    ];
    let n = 0;
    // Exactly as the real own-write ledger behaves after the daemon's own
    // label write (writer "daemon"): it suppresses EVERY watcher of the
    // bumped ticket, not just the ticket's own agent — see own-writes.ts.
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      suppress: (key, updated) => key === "K" && updated === "t2",
      // KAN-828: K's watcher-loop consult of the ledger hit now runs the
      // daemonLabelsChanged comment-cursor check (pr:open->pr:approved IS a
      // daemon label change). This is K's FIRST sighting, so baseline
      // seeding and the ledger-hit check draw from the SAME poll's SAME
      // memoized comments() call — trivially "no new comment" — so W stays
      // suppressed exactly as before. Any stub that resolves proves that;
      // the id's value doesn't matter here.
      comments: async () => [{ id: "x", body: "b", created: "c", authorEmail: null }],
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    expect(kEvents.length).toBe(1);
    expect(kEvents[0]!.reason).toEqual({ pr: { from: "open", to: "approved" } });
    expect(notified.some((e) => e.issue === "W")).toBe(false); // watcher via Implements chain not notified
  });

  test("cross-daemon path: still exactly one wake even though isDaemonLabelOnlyDiff + a matching comment baseline would otherwise suppress it", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    const oneComment = () => [{ id: "5", body: "x", created: "c", authorEmail: null }];
    const polls: JiraIssue[][] = [
      [withPr(["agent:working", "pr:open"], "t0")],   // baseline poll
      [withPr(["agent:idle", "pr:open"], "t1")],       // agent:*-only diff: K's first sighting — KAN-828 baseline seeding fetches "5" HERE, before crossDaemonSuppressed ever runs, so this poll is suppressed rather than delivered on an "unknown baseline"
      [withPr(["agent:idle", "pr:approved"], "t2")],   // pr:* transition, ALSO a label-only diff with a MATCHING baseline
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      suppress: () => false,
      comments: async () => oneComment(),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    // KAN-828: poll1 no longer contributes an event — baseline seeding
    // already populated the cursor with "5" before crossDaemonSuppressed
    // consulted it this same poll, so it correctly suppresses (no new
    // comment) rather than delivering on what used to be an unknown
    // baseline. The point this test pins — poll2's pr:* transition is
    // delivered PAST a matching cross-daemon baseline that would otherwise
    // suppress it — is unaffected.
    expect(kEvents.length).toBe(1); // poll2 (the transition, WOULD be suppressed by the matching baseline but isn't)
    expect(kEvents[0]!.reason).toEqual({ pr: { from: "open", to: "approved" } });
  });

  test("control: an agent:*-only diff with the ledger suppressing it produces zero wakes — unchanged behaviour", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [
      [withPr(["agent:working"], "t1")],
      [withPr(["agent:idle"], "t2")],
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      suppress: (key, updated) => key === "K" && updated === "t2",
      // KAN-828: agent:working->agent:idle IS a daemon label change, so the
      // ledger hit now runs the comment-cursor check. This is K's FIRST
      // sighting, so baseline seeding and the check draw from the SAME
      // poll's SAME memoized comments() call — trivially "no new comment" —
      // so this stays suppressed exactly as before, unchanged behaviour.
      comments: async () => [{ id: "x", body: "b", created: "c", authorEmail: null }],
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified.filter((e) => e.issue === "K").length).toBe(0);
  });

  test("fail-open pin: a pr:* transition leaves the comment cursor stale (never advanced), and a LATER agent:*-only diff whose newest comment moved on since that stale baseline is still DELIVERED, not wrongly suppressed (KAN-819 epic ruling)", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    const responses = [[{ id: "5", body: "x", created: "c", authorEmail: null }], [{ id: "6", body: "x", created: "c", authorEmail: null }]];
    let commentCalls = 0;
    const comments = async () => { const r = responses[Math.min(commentCalls, 1)]!; commentCalls++; return r; };
    const polls: JiraIssue[][] = [
      [withPr(["agent:working", "pr:open"], "t0")],    // baseline poll
      [withPr(["agent:idle", "pr:open"], "t1")],        // agent:*-only diff: K's first sighting — KAN-828 baseline seeding fetches "5" HERE, before crossDaemonSuppressed ever runs
      [withPr(["agent:idle", "pr:approved"], "t2")],    // P: pr:* transition — delivered past suppression, cursor NOT touched (stays "5")
      [withPr(["agent:working", "pr:approved"], "t3")], // Q: agent:*-only diff again; newest comment has moved to "6" since the stale "5" baseline
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    // KAN-828 changes poll1's outcome from the pre-KAN-828 baseline: baseline
    // seeding now populates K's comment cursor (with "5") BEFORE
    // crossDaemonSuppressed ever consults it, on this same first-sighting
    // poll — so crossDaemonSuppressed no longer finds an "unknown baseline"
    // there (that was always a some-signal-is-better-than-none compromise);
    // it finds a real one that matches, and correctly suppresses. Poll2 (the
    // transition) and poll3 (the stale-cursor catch-up) are unchanged.
    expect(kEvents.length).toBe(2); // poll2 (the transition, exempted), poll3 (delivered despite the stale cursor)
    expect(kEvents[0]!.reason).toEqual({ pr: { from: "open", to: "approved" } });
    // BUTCHR-87: poll3 is delivered BECAUSE the newest comment id moved past
    // the stale baseline (crossDaemonSuppressed's becauseComment branch) —
    // that is now named as its own reason, honestly, rather than left bare.
    expect(kEvents[1]!.reason).toEqual({ comment: true });
    // Exactly 2 comments() calls: poll1 (baseline seeding) and poll3
    // (crossDaemonSuppressed) — poll2's transition never consults the cursor
    // at all, so it genuinely never advances during it; the swap to "6" is
    // discovered only at poll3.
    expect(commentCalls).toBe(2);
  });
});

describe("startLoop: every notify reason class is named, driven through the real decide()/notify path (BUTCHR-87)", () => {
  const mk = (fields: Partial<JiraIssue> & { updated: string }): JiraIssue =>
    ({ key: "K", status: "In Progress", summary: "s", issuetype: "Task", assignee: "a", parent: null, labels: [], ...fields });

  test("status transition is named with both from and to", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [[mk({ status: "In Progress", updated: "t1" })], [mk({ status: "In Review", updated: "t2" })]];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K");
    expect(kEvents.length).toBe(1);
    expect(kEvents[0]!.reason).toEqual({ status: { from: "In Progress", to: "In Review" } });
  });

  test("a daemon agent:* label transition is named — the single most common wake in the fleet, unnamed before this ticket", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [[mk({ labels: ["agent:working"], updated: "t1" })], [mk({ labels: ["agent:idle"], updated: "t2" })]];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
      suppress: () => false, // not this daemon's own write -> the general classifier, not the ledger-hit arm
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K");
    expect(kEvents.length).toBe(1);
    expect(kEvents[0]!.reason).toEqual({ label: { prefix: "agent", from: "working", to: "idle" } });
  });

  test("a summary edit is named", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [[mk({ summary: "old", updated: "t1" })], [mk({ summary: "new", updated: "t2" })]];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K");
    expect(kEvents.length).toBe(1);
    expect(kEvents[0]!.reason).toEqual({ summary: true });
  });

  test("appeared and disappeared are both named", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [[], [mk({ updated: "t1" })], []];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K");
    expect(kEvents.length).toBe(2);
    expect(kEvents[0]!.reason).toEqual({ appeared: true });
    expect(kEvents[1]!.reason).toEqual({ disappeared: true });
  });

  test("a pr:* label transition on a RELATED (watcher) path is named as a label transition, NOT the self-only pr reason — a boss must never be told 'your PR' about its implementer's PR", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    const relPolls = [
      [{ issue: mk({ labels: ["pr:open"], updated: "t1" }), watchers: ["W"] }],
      [{ issue: mk({ labels: ["pr:approved"], updated: "t2" }), watchers: ["W"] }],
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => [],
      related: async () => relPolls[Math.min(n++, relPolls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    expect(wEvents.length).toBe(1);
    expect(wEvents[0]!.reason).toEqual({ label: { prefix: "pr", from: "open", to: "approved" } });
  });

  test("a pure `updated` bump with every other field identical, and no comments dep wired up, carries NO reason — the honest fallback, not a guess", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; reason: unknown }> = [];
    const polls: JiraIssue[][] = [[mk({ updated: "t1" })], [mk({ updated: "t2" })]];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
      // No `suppress` and no `comments` deps at all: nothing in this poll
      // could ever learn about a comment, so this must fall all the way
      // through to the honest "no reason" fallback, never a guess.
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K");
    expect(kEvents.length).toBe(1);
    expect(kEvents[0]!.reason).toBeUndefined();
  });

  describe("precedence: more than one class true of the same diff (documented order — status > daemon label > summary > comment)", () => {
    test("status change AND a daemon label change in the same diff -> status wins", async () => {
      const herd = fakeHerd();
      const notified: Array<{ issue: string; reason: unknown }> = [];
      const polls: JiraIssue[][] = [
        [mk({ status: "In Progress", labels: ["agent:working"], updated: "t1" })],
        [mk({ status: "In Review", labels: ["agent:idle"], updated: "t2" })],
      ];
      let n = 0;
      const stop = startLoop({
        search: async () => polls[Math.min(n++, polls.length - 1)]!,
        herd,
        notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
        suppress: () => false,
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 40));
      stop();
      const kEvents = notified.filter((e) => e.issue === "K");
      expect(kEvents.length).toBe(1);
      expect(kEvents[0]!.reason).toEqual({ status: { from: "In Progress", to: "In Review" } });
    });

    test("a daemon label change AND a summary edit in the same diff -> the label transition wins", async () => {
      const herd = fakeHerd();
      const notified: Array<{ issue: string; reason: unknown }> = [];
      const polls: JiraIssue[][] = [
        [mk({ summary: "old", labels: ["agent:working"], updated: "t1" })],
        [mk({ summary: "new", labels: ["agent:idle"], updated: "t2" })],
      ];
      let n = 0;
      const stop = startLoop({
        search: async () => polls[Math.min(n++, polls.length - 1)]!,
        herd,
        notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
        suppress: () => false,
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 40));
      stop();
      const kEvents = notified.filter((e) => e.issue === "K");
      expect(kEvents.length).toBe(1);
      expect(kEvents[0]!.reason).toEqual({ label: { prefix: "agent", from: "working", to: "idle" } });
    });

    test("a pr:* transition on the SELF path always wins over everything, unchanged behaviour — status/summary/agent-label all changing in the same poll still yields the pr reason", async () => {
      const herd = fakeHerd();
      const notified: Array<{ issue: string; reason: unknown }> = [];
      const polls: JiraIssue[][] = [
        [mk({ status: "In Progress", summary: "old", labels: ["agent:working", "pr:open"], updated: "t1" })],
        [mk({ status: "In Review", summary: "new", labels: ["agent:idle", "pr:approved"], updated: "t2" })],
      ];
      let n = 0;
      const stop = startLoop({
        search: async () => polls[Math.min(n++, polls.length - 1)]!,
        herd,
        notify: (issue, _about, reason) => { notified.push({ issue, reason }); },
        suppress: () => false,
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 40));
      stop();
      const kEvents = notified.filter((e) => e.issue === "K");
      expect(kEvents.length).toBe(1);
      expect(kEvents[0]!.reason).toEqual({ pr: { from: "open", to: "approved" } });
    });
  });
});

describe("startLoop DAEMON_WRITER ledger-hit comment-cursor discriminator (KAN-828, KAN-793/799/804 race)", () => {
  // A non-pr label throughout — so KAN-819's prTransition exemption cannot
  // mask the behaviour under test (per the ticket's test instructions).
  const withLabels = (labels: string[], updated: string): JiraIssue =>
    ({ key: "K", status: "In Progress", summary: "s", issuetype: "Task", assignee: "a", parent: null, updated, labels });
  const relK = (labels: string[], updated: string) => [{ issue: withLabels(labels, updated), watchers: ["W"] }];
  const comment = (id: string): JiraComment => ({ id, body: "x", created: "c", authorEmail: null });

  test("(a) THE RACE: a foreign comment folded into a daemon label write's read-back is delivered once the newest comment id has moved, to both K's own agent and its watcher", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    const responses = [[comment("c1")], [comment("c2"), comment("c1")]];
    let commentCalls = 0;
    const comments = async () => { const r = responses[Math.min(commentCalls, responses.length - 1)]!; commentCalls++; return r; };
    // idx0: silent baseline (K absent — watch()'s first fetch never invokes
    // the diff callback, see @brooswit/sundry's watcher.ts). idx1: K appears
    // — this is K's first sighting, so baseline seeding fetches "c1" here
    // (an appear always delivers unconditionally, unrelated to the race).
    // idx2: the RACE — labels flip (a daemon write, ledger records it), but
    // a foreign comment "c2" landed first and is folded into the read-back.
    const polls: JiraIssue[][] = [[], [withLabels(["agent:working"], "t1")], [withLabels(["agent:idle"], "t2")]];
    const relatedPolls = [[], relK(["agent:working"], "t1"), relK(["agent:idle"], "t2")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      suppress: (key, updated) => key === "K" && updated === "t2", // the ledger hit, exactly as own-writes.ts would report it
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    // idx1 contributes one appear-delivery each (always delivered,
    // unconditionally, regardless of the race); idx2 contributes exactly one
    // more each — the race event itself: the ledger hit is not final because
    // daemonLabelsChanged is true, and the newest comment id moved ("c1" ->
    // "c2"), so it is delivered rather than swallowed.
    expect(kEvents.length).toBe(2); // idx1 appear + idx2 THE RACE
    expect(wEvents.length).toBe(2); // idx1 appear + idx2 THE RACE, reaching the watcher too
    // Exactly one comments() call per key per poll, TOTAL — idx1's seed and
    // idx2's ledger-hit check each make exactly one, shared by BOTH K's own
    // agent's consult and W's consult within the same poll.
    expect(commentCalls).toBe(2);
  });

  test("(b) CONTROL: a DAEMON_WRITER ledger hit whose newest comment id has NOT moved stays suppressed — the echo suppression is intact", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return [comment("c1")]; }; // same newest id every call — no new comment, ever
    const polls: JiraIssue[][] = [[], [withLabels(["agent:working"], "t1")], [withLabels(["agent:idle"], "t2")]];
    const relatedPolls = [[], relK(["agent:working"], "t1"), relK(["agent:idle"], "t2")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      suppress: (key, updated) => key === "K" && updated === "t2",
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    expect(kEvents.length).toBe(1); // just idx1's appear; idx2's ledger hit has no new comment -> suppressed
    expect(wEvents.length).toBe(1); // same for the watcher
    expect(commentCalls).toBe(2);
  });

  test("(c) FAIL-OPEN: comments() rejecting on the ledger-hit poll delivers anyway and leaves the cursor untouched; the FOLLOWING poll with a genuine new comment still delivers", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    let commentCalls = 0;
    // call 1 (idx1 seed): succeeds, "c1". call 2 (idx2 ledger hit): REJECTS.
    // call 3 (idx3 ledger hit): succeeds, "c2" — genuinely new since the
    // STILL-"c1" baseline (idx2's rejection never touched the cursor).
    const comments = async () => {
      commentCalls++;
      if (commentCalls === 2) throw new Error("503 unavailable");
      return commentCalls < 3 ? [comment("c1")] : [comment("c2"), comment("c1")];
    };
    const polls: JiraIssue[][] = [
      [],
      [withLabels(["agent:working"], "t1")],
      [withLabels(["agent:idle"], "t2")],
      [withLabels(["agent:working"], "t3")],
    ];
    const relatedPolls = [[], relK(["agent:working"], "t1"), relK(["agent:idle"], "t2"), relK(["agent:working"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n, polls.length - 1)]!,
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      suppress: (key, updated) => key === "K" && (updated === "t2" || updated === "t3"),
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    // idx1: appear. idx2: comments() rejects on the ledger hit -> FAIL OPEN,
    // delivered, cursor left at "c1" (untouched). idx3: a genuine new
    // comment ("c2") since that still-"c1" baseline -> delivered.
    expect(kEvents.length).toBe(3);
    expect(wEvents.length).toBe(3);
    expect(commentCalls).toBe(3);
  });

  test("(d) SEEDING: a key first sighted mid-run is seeded on the poll it appears; a daemon label write on the VERY NEXT poll with no new comment produces zero wakes — the seed prevents the first-hit echo", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return [comment("c1")]; }; // no new comment, ever
    // "Z" is present from the start and changes on its own — this forces an
    // onChange poll BEFORE K ever exists, proving K is untouched by it (K
    // isn't in next.issues/next.related that poll, so nothing seeds it yet).
    // K then appears mid-run (idx2) — a newly staffed ticket — and gets
    // seeded right there. idx3 is a pure daemon agent:* write on K, and
    // ONLY on K (Z holds still) — the ledger hit this test is about.
    const zIss = (status: string): JiraIssue => ({ key: "Z", status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: status, labels: [] });
    const polls: JiraIssue[][] = [
      [zIss("In Progress")],
      [zIss("In Review")],                                                     // Z changes; K still doesn't exist
      [zIss("In Review"), withLabels(["agent:working"], "t1")],                 // K appears mid-run — seeded here
      [zIss("In Review"), withLabels(["agent:idle"], "t2")],                    // K: a daemon label write only, no new comment
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      suppress: (key, updated) => key === "K" && updated === "t2",
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    expect(kEvents.length).toBe(1); // just K's mid-run appear; the seed it gets there prevents an echo on the very next poll's ledger hit
    // 3 total: Z's own first-sighting seed (idx1, unrelated to K — proves
    // seeding runs for every key in the snapshot, not just ones with a
    // daemon-label ledger hit), K's first-sighting seed (idx2), and K's
    // ledger-hit check (idx3).
    expect(commentCalls).toBe(3);
  });

  test("(e) DEDUPE: a pr:* transition AND a daemon-recorded ledger hit in the same poll deliver exactly ONE nudge to K, carrying the pr reason — the transition exemption short-circuits before the cursor is ever consulted", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string; reason: unknown }> = [];
    let commentCalls = 0;
    const comments = async () => { commentCalls++; return [comment("c1")]; };
    const polls: JiraIssue[][] = [
      [],
      [withLabels(["agent:working", "pr:open"], "t1")],
      [withLabels(["agent:working", "pr:approved"], "t2")], // BOTH a pr:* transition AND a ledger hit (the label sync write that flipped pr:open->pr:approved)
    ];
    let n = 0;
    const stop = startLoop({
      search: async () => polls[Math.min(n++, polls.length - 1)]!,
      herd,
      notify: (issue, about, reason) => { notified.push({ issue, about, reason }); },
      suppress: (key, updated) => key === "K" && updated === "t2",
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    // idx1 contributes K's appear (always delivered, named {appeared:true}
    // — BUTCHR-87); idx2 is the event under test — exactly ONE nudge, not
    // two, despite the poll
    // carrying both a pr:* transition AND a ledger hit that (were the
    // transition exemption absent) the comment-cursor check would ALSO have
    // independently evaluated.
    expect(kEvents.length).toBe(2);
    // BUTCHR-87: idx1's appear is now named too — appear/disappear was
    // always delivered unconditionally (see decide()'s comment), and is
    // one of the classes the poll can establish outright with no I/O.
    expect(kEvents[0]!.reason).toEqual({ appeared: true });
    expect(kEvents[1]!.reason).toEqual({ pr: { from: "open", to: "approved" } });
    // The transition branch sends and `continue`s BEFORE suppressed() (and
    // so the comment-cursor check) is ever consulted for K's own site — only
    // the idx1 seed ever calls comments(), proving the cursor genuinely
    // wasn't consulted for the transition poll, not just that its result was
    // discarded by the `sent` dedupe.
    expect(commentCalls).toBe(1);
  });
});

describe("startLoop KAN-838: agent-writer arm must advance the comment cursor (regression)", () => {
  // Same fixtures as the KAN-828 suite above.
  const withLabels = (labels: string[], updated: string): JiraIssue =>
    ({ key: "K", status: "In Progress", summary: "s", issuetype: "Task", assignee: "a", parent: null, updated, labels });
  const relK = (labels: string[], updated: string) => [{ issue: withLabels(labels, updated), watchers: ["W"] }];
  const comment = (id: string): JiraComment => ({ id, body: "x", created: "c", authorEmail: null });

  test("(f) THE BUG: an agent's own comment (agent-writer arm, no label change) leaves the cursor stale, so the VERY NEXT daemon label flip with no new comment wrongly wakes K's own agent AND its watcher W", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    let commentCalls = 0;
    let pollIndex = 0;
    // What deps.comments(K) would genuinely return if queried during poll
    // `pollIndex` — independent of how many times (0 or 1) our code under
    // test actually calls it that poll, so this fixture is valid whether or
    // not the fix is applied yet.
    const commentsByPoll: Record<number, JiraComment[]> = {
      1: [comment("c1")],               // idx1: K appears — baseline seed sees "c1"
      2: [comment("c2"), comment("c1")], // idx2: the agent's OWN comment "c2" just landed
      3: [comment("c2"), comment("c1")], // idx3: unchanged since idx2 — no genuinely new comment
    };
    const comments = async () => { commentCalls++; return commentsByPoll[pollIndex] ?? [comment("c1")]; };
    const polls: JiraIssue[][] = [
      [],                                        // idx0: silent baseline
      [withLabels(["agent:working"], "t1")],     // idx1: K appears
      [withLabels(["agent:working"], "t2")],     // idx2 (poll N): agent's own comment — NO label change
      [withLabels(["agent:idle"], "t3")],        // idx3 (poll N+1): daemon flips the label, no new comment since idx2
    ];
    const relatedPolls = [[], relK(["agent:working"], "t1"), relK(["agent:working"], "t2"), relK(["agent:idle"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => { pollIndex = Math.min(n, polls.length - 1); return polls[pollIndex]!; },
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      // idx2 ("t2"): the AGENT-writer arm — writer is K itself, so only K's
      // own site is suppressed by the ledger; a watcher (W) is NOT this
      // writer, exactly as own-writes.ts would report it.
      // idx3 ("t3"): a DAEMON_WRITER label flip — suppressed for every site
      // pending the comment-cursor check.
      suppress: (key, updated, watcher) => {
        if (key !== "K") return false;
        if (updated === "t2") return watcher === "K";
        if (updated === "t3") return true;
        return false;
      },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    // idx1: appear, delivered to both (unconditional). idx2: K's own agent is
    // suppressed (agent-writer arm); W is NOT suppressed by the ledger (it
    // isn't the writer) and isDaemonLabelOnlyDiff is false (no label changed
    // at all here), so W hears the agent's own comment too — that's the
    // existing, correct "boss still hears it" behaviour, unrelated to this
    // bug. idx3: a pure daemon label flip with NO genuinely new comment since
    // idx2 — this MUST be zero further wakes for both K and W. Before the
    // fix, the cursor is still stuck at idx1's "c1" (the agent-writer arm at
    // idx2 never advanced it), so idx3 sees "c2" != "c1" and WRONGLY
    // delivers to both — the exact self-notify-storm shape from the ticket.
    expect(kEvents.length).toBe(1); // idx1 appear only — idx3 must NOT wake K about its own already-suppressed comment
    expect(wEvents.length).toBe(2); // idx1 appear + idx2's genuine (unrelated) deliver — idx3 must NOT add a third
  });

  test("(g) WATCHER + FOREIGN COMMENT IN WINDOW: a foreign comment folded into the SAME read-back window as the agent's own write still reaches watcher W (via crossDaemon, cursor-independent); K's own agent stays suppressed either way (stated residual); the cursor still advances to the TRUE newest id, not just the agent's own", async () => {
    const herd = fakeHerd();
    const notified: Array<{ issue: string; about: string }> = [];
    let pollIndex = 0;
    const commentsByPoll: Record<number, JiraComment[]> = {
      1: [comment("c1")],
      // idx2: BOTH the agent's own comment "c2" AND a foreign comment "f1"
      // landed in the same read-back window — "f1" is the true newest.
      2: [comment("f1"), comment("c2"), comment("c1")],
      // idx3: nothing new since idx2 (still "f1" newest) — a correct cursor
      // must recognize this as "no new comment", not just compare against
      // the agent's own "c2".
      3: [comment("f1"), comment("c2"), comment("c1")],
    };
    const comments = async () => commentsByPoll[pollIndex] ?? [comment("c1")];
    const polls: JiraIssue[][] = [
      [],
      [withLabels(["agent:working"], "t1")],
      [withLabels(["agent:working"], "t2")],
      [withLabels(["agent:idle"], "t3")],
    ];
    const relatedPolls = [[], relK(["agent:working"], "t1"), relK(["agent:working"], "t2"), relK(["agent:idle"], "t3")];
    let n = 0;
    const stop = startLoop({
      search: async () => { pollIndex = Math.min(n, polls.length - 1); return polls[pollIndex]!; },
      related: async () => relatedPolls[Math.min(n++, relatedPolls.length - 1)]!,
      herd,
      notify: (issue, about) => { notified.push({ issue, about }); },
      suppress: (key, updated, watcher) => {
        if (key !== "K") return false;
        if (updated === "t2") return watcher === "K";
        if (updated === "t3") return true;
        return false;
      },
      comments,
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    const kEvents = notified.filter((e) => e.issue === "K" && e.about === "K");
    const wEvents = notified.filter((e) => e.issue === "W" && e.about === "K");
    // K's own agent: idx1 appear only. idx2's agent-writer arm ALWAYS
    // suppresses (regardless of what landed in the window) — K never learns
    // about the foreign comment "f1" either. Stated residual: this is the
    // one case the agent-writer arm cannot recover — known and accepted, not
    // this ticket's regression to fix (see the ledger-hit comment block).
    expect(kEvents.length).toBe(1);
    // W: idx1 appear + idx2 delivered via crossDaemonSuppressed (a pure
    // comment diff is never daemon-label-only, so W hears it independent of
    // any cursor state) + idx3 must NOT add a third, because the cursor
    // correctly advanced to the TRUE newest ("f1"), not "c2".
    expect(wEvents.length).toBe(2);
  });
});

describe("startLoop respawn wiring", () => {
  test("deps.onRespawn is invoked through reconcileNow when a stale agent is found", async () => {
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

  test("the storm guard persists ACROSS polls: an issue stale on EVERY poll is still respawned only once in the suppression window, and deps.log receives the WARNING", async () => {
    // Same shape as the measured KAN-811 storm: staleIssues() keeps reporting
    // "A" stale every single poll (a genuinely broken agent, or the old bug's
    // stray-process misread). startLoop must create ONE RespawnGuard for its
    // whole lifetime — a guard freshly constructed per poll (module-level
    // state done wrong, or no guard at all) would respawn it every 10ms poll.
    const herd = fakeHerd(["A"], [{ issue: "A", reason: "argv lacks --permission-mode bypassPermissions", observedArgv: ["claude", "--resume", "x"] }]);
    const respawns: any[] = [];
    const logged: string[] = [];
    const stop = startLoop({
      search: async () => [iss("A", "In Progress")],
      herd,
      notify: () => {},
      onRespawn: (issue, reason, observedArgv) => { respawns.push({ issue, reason, observedArgv }); },
      log: (line) => logged.push(line),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 45)); // well inside the 5-poll suppression window at a 10ms interval
    stop();
    expect(respawns.length).toBe(1);                 // respawned once, not once per poll
    expect(herd.stopped).toEqual(["A"]);
    expect(herd.spawned).toEqual(["A"]);
    expect(logged.length).toBeGreaterThan(0);         // the storm-guard WARNING made it out through deps.log
    for (const line of logged) expect(line).toContain("respawned again within 5 polls — suppressing further respawns");
  });
});

describe("startLoop checkParked wiring (BUTCHR-24)", () => {
  // @brooswit/sundry's watch() only calls its onChange callback when the
  // polled snapshot's hash differs from the previous one — a detector wired
  // into onChange would silently stop firing on any poll whose snapshot
  // doesn't change. checkParked must be invoked from the observe function
  // instead, so it runs on EVERY poll, changed or not — this is the trap the
  // ticket calls out, and it needs its own test, independent of anything the
  // parked predicate itself does.
  test("checkParked runs on every poll, including a poll whose (issues, related) snapshot is identical to the previous one", async () => {
    const herd = fakeHerd();
    const calls: Array<{ issues: JiraIssue[]; related: unknown[] }> = [];
    // The SAME issue/related snapshot every poll — watch()'s hash never
    // changes, so onChange would never fire if checkParked were wired there.
    const stop = startLoop({
      search: async () => [iss("A", "In Progress")],
      related: async () => [],
      herd,
      notify: () => {},
      checkParked: async (issues, related) => { calls.push({ issues: [...issues], related: [...related] }); },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 55));
    stop();
    // At a 10ms interval over ~55ms we expect several polls; the point is
    // strictly more than one despite the snapshot never changing.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]!.issues[0]!.key).toBe("A");
  });

  test("a checkParked rejection is caught: does not stop the loop, and does not appear as a notify or onError event", async () => {
    const herd = fakeHerd();
    let calls = 0;
    const errors: unknown[] = [];
    const stop = startLoop({
      search: async () => [iss("A", "In Progress")],
      related: async () => [],
      herd,
      notify: () => {},
      checkParked: async () => { calls++; throw new Error("boom"); },
      onError: (e) => errors.push(e),
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 35));
    stop();
    expect(calls).toBeGreaterThan(1); // kept polling despite the rejection
    expect(errors).toEqual([]); // startLoop's own onError is for the fetch/reconcile stage, not checkParked's internal errors
  });
});
