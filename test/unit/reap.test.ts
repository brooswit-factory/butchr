import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HerdrHerd } from "../../src/agents/herd.js";
import { strandedCandidates, ReapGuard, createReaper, type StrandedCandidate } from "../../src/agents/reap.js";
import { workspaceRoot } from "../../src/agents/workspace.js";

const root = workspaceRoot();
const MIN = 60_000;

/** One foreground process, as herdr's `pane.process_info` reports it. */
interface FakeProcess { pid: number; argv?: string[] | null; name?: string }

// ---------------------------------------------------------------------------
// 1/2/5/7: strandedCandidates — pure ownership+agentless join
// ---------------------------------------------------------------------------
describe("strandedCandidates", () => {
  test("an agent that exited without going through stop() — workspace survives with no matching agent, owned by cwd — is a candidate", () => {
    const workspaces = [{ workspace_id: "w1", label: "BUTCHR-9" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] as any[];
    const agents = [] as any[]; // nothing in agent.list() names w1 — the exact "vanished from agent.list()" shape
    const out = strandedCandidates(workspaces, panes, agents, root);
    expect(out).toEqual([{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }]);
  });

  test("a workspace with a live herdr-known agent is never a candidate, even though its pane cwd is owned", () => {
    const workspaces = [{ workspace_id: "w1", label: "BUTCHR-9" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] as any[];
    const agents = [{ workspace_id: "w1" }] as any[];
    expect(strandedCandidates(workspaces, panes, agents, root)).toEqual([]);
  });

  test("the pane's cwd is somewhere else entirely, not under root at all — never a candidate (a workspace butchr did not create), whatever the label says", () => {
    const workspaces = [{ workspace_id: "w1", label: "BUTCHR-9" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(strandedCandidates(workspaces, panes, [], root)).toEqual([]);
  });

  test("FACTORY-92: label is a human-readable string DIFFERENT from the real agent key, but the pane cwd IS a real butchr workspace dir — still recognized as stranded/butchr-owned, keyed on the REAL agent key from cwd, never the label", () => {
    // herdr reports a human-readable label ("admin-assembly"), not the raw
    // percent-encoded agent key — this is FACTORY-83's eventual behaviour,
    // simulated early. Ownership must still be proven, and the derived
    // agentKey must be the REAL key (from cwd), not the pretty label.
    const workspaces = [{ workspace_id: "w1", label: "admin-assembly" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "jira-work", "task", "BUTCHR-9") }] as any[];
    const out = strandedCandidates(workspaces, panes, [], root);
    expect(out).toEqual([{ workspaceId: "w1", label: "admin-assembly", agentKey: "jira-work:task:BUTCHR-9", paneIds: ["w1:p1"] }]);
  });

  test("FACTORY-92: label LOOKS like a valid agent key, but the pane cwd is OUTSIDE the workspace root — never a candidate; a label alone must never grant ownership", () => {
    const workspaces = [{ workspace_id: "w1", label: "jira-work:task:BUTCHR-9" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(strandedCandidates(workspaces, panes, [], root)).toEqual([]);
  });

  test("FACTORY-92: label LOOKS like a valid agent key, but the pane cwd belongs to a DIFFERENT key entirely — never a candidate under the label's key; ownership follows the cwd, not the label", () => {
    const workspaces = [{ workspace_id: "w1", label: "jira-work:task:BUTCHR-9" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "jira-work", "task", "BUTCHR-99") }] as any[];
    const out = strandedCandidates(workspaces, panes, [], root);
    expect(out).toEqual([{ workspaceId: "w1", label: "jira-work:task:BUTCHR-9", agentKey: "jira-work:task:BUTCHR-99", paneIds: ["w1:p1"] }]);
  });

  test("FACTORY-92: label is human-readable AND the pane cwd is a foreign (non-butchr) directory — never a candidate", () => {
    const workspaces = [{ workspace_id: "w1", label: "FACTORY-51 · jira-work" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(strandedCandidates(workspaces, panes, [], root)).toEqual([]);
  });

  test("FACTORY-92: a bare project-tier label (a bare project key) never grants ownership by itself — the pane cwd, not the label, decides", () => {
    const workspaces = [{ workspace_id: "w1", label: "FACTORY" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(strandedCandidates(workspaces, panes, [], root)).toEqual([]);
  });

  test("agent-known workspaces stay excluded even with a human-readable label and a genuinely-owned cwd", () => {
    const workspaces = [{ workspace_id: "w1", label: "admin-assembly" }] as any[];
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "jira-work", "task", "BUTCHR-9") }] as any[];
    const agents = [{ workspace_id: "w1" }] as any[];
    expect(strandedCandidates(workspaces, panes, agents, root)).toEqual([]);
  });

  test("duplicate label case: two workspaces share a label, one live and one stranded — exactly the stranded one is a candidate", () => {
    const workspaces = [
      { workspace_id: "w-live", label: "BUTCHR-9" },
      { workspace_id: "w-stranded", label: "BUTCHR-9" },
    ] as any[];
    const panes = [
      { pane_id: "wlive:p1", workspace_id: "w-live", cwd: join(root, "BUTCHR-9") },
      { pane_id: "wstranded:p1", workspace_id: "w-stranded", cwd: join(root, "BUTCHR-9") },
    ] as any[];
    const agents = [{ workspace_id: "w-live" }] as any[]; // only the live one is in agent.list()
    const out = strandedCandidates(workspaces, panes, agents, root);
    expect(out).toEqual([{ workspaceId: "w-stranded", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["wstranded:p1"] }]);
  });

  test("a workspace with no panes reported is never a candidate (ownership unprovable)", () => {
    const workspaces = [{ workspace_id: "w1", label: "BUTCHR-9" }] as any[];
    expect(strandedCandidates(workspaces, [], [], root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6: ReapGuard — the across-poll grace period
// ---------------------------------------------------------------------------
describe("ReapGuard", () => {
  test("not eligible on first observation", () => {
    const guard = new ReapGuard();
    expect(guard.observe(new Set(["w1"]), 0)).toEqual([]);
  });

  test("not eligible on a second observation before 60s of wall clock have passed", () => {
    const guard = new ReapGuard();
    guard.observe(new Set(["w1"]), 0);
    expect(guard.observe(new Set(["w1"]), MIN - 1)).toEqual([]);
  });

  test("eligible once BOTH two observations AND >= 60s have elapsed", () => {
    const guard = new ReapGuard();
    guard.observe(new Set(["w1"]), 0);
    expect(guard.observe(new Set(["w1"]), MIN)).toEqual(["w1"]);
  });

  test("a third+ observation after eligibility keeps reporting eligible (still a candidate every later poll until reclaimed or it stops being one)", () => {
    const guard = new ReapGuard();
    guard.observe(new Set(["w1"]), 0);
    guard.observe(new Set(["w1"]), MIN);
    expect(guard.observe(new Set(["w1"]), MIN * 2)).toEqual(["w1"]);
  });

  test("the counter resets when the workspace drops out of the candidate set in between (gained an agent, or disappeared) — a later reappearance starts over", () => {
    const guard = new ReapGuard();
    guard.observe(new Set(["w1"]), 0);
    guard.observe(new Set<string>(), MIN); // w1 absent this poll — gained an agent, say
    // w1 reappears later: this is observation #1 of a FRESH episode, not #3 of the old one
    expect(guard.observe(new Set(["w1"]), MIN + 1)).toEqual([]);
    expect(guard.observe(new Set(["w1"]), MIN + 1 + MIN)).toEqual(["w1"]);
  });

  test("independent ids are tracked independently", () => {
    const guard = new ReapGuard();
    guard.observe(new Set(["w1"]), 0);
    guard.observe(new Set(["w1", "w2"]), MIN); // w2's first observation
    expect(guard.observe(new Set(["w1", "w2"]), MIN * 2)).toEqual(["w1", "w2"]);
  });
});

// ---------------------------------------------------------------------------
// 3/4: HerdrHerd.closeStranded — the live-process safety layer
// ---------------------------------------------------------------------------
describe("HerdrHerd.closeStranded", () => {
  function fakeHerdrForClose(processInfo: (paneId: string) => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>, closeFails = false) {
    const closed: string[] = [];
    const client = {
      workspace: { close: async (p: { workspace_id: string }) => { if (closeFails) throw new Error("herdr close boom"); closed.push(p.workspace_id); } },
      pane: { processInfo: (p: { pane_id: string }) => processInfo(p.pane_id) },
    };
    return { client: client as any, closed };
  }
  const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });
  const candidate = (paneIds: string[]): StrandedCandidate => ({ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds });

  test("a live-but-unlisted agent (processInfo reports a claude in the foreground) is never reaped", async () => {
    const f = fakeHerdrForClose(ok([{ pid: 1, name: "claude", argv: ["claude", "hi"] }]));
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("processInfo throwing is UNKNOWN, never dead — not reaped", async () => {
    const f = fakeHerdrForClose(async () => { throw new Error("herdr hiccup"); });
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("a missing process_info in the result is UNKNOWN, never dead — not reaped", async () => {
    const f = fakeHerdrForClose(async () => ({}));
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("empty foreground_processes is UNKNOWN, never dead — not reaped", async () => {
    const f = fakeHerdrForClose(ok([]));
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("every pane reports a non-claude foreground process (e.g. fish) — reaped", async () => {
    const f = fakeHerdrForClose(ok([{ pid: 1, name: "fish", argv: ["/usr/bin/fish"] }]));
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(true);
    expect(f.closed).toEqual(["w1"]);
  });

  test("multiple panes, one live — the whole workspace is vetoed, not reaped", async () => {
    const responses: Record<string, () => Promise<any>> = {
      "w1:p1": ok([{ pid: 1, name: "fish", argv: ["/usr/bin/fish"] }]),
      "w1:p2": ok([{ pid: 2, name: "claude", argv: ["claude"] }]),
    };
    const f = fakeHerdrForClose((paneId) => responses[paneId]!());
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1", "w1:p2"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("multiple panes, one unknown (the rest dead) — the whole workspace stays unknown, not reaped", async () => {
    const responses: Record<string, () => Promise<any>> = {
      "w1:p1": ok([{ pid: 1, name: "fish", argv: ["/usr/bin/fish"] }]),
      "w1:p2": async () => { throw new Error("hiccup"); },
    };
    const f = fakeHerdrForClose((paneId) => responses[paneId]!());
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1", "w1:p2"]))).toBe(false);
    expect(f.closed).toEqual([]);
  });

  test("workspace.close itself rejecting is caught — resolves false, never throws", async () => {
    const f = fakeHerdrForClose(ok([{ pid: 1, name: "fish", argv: ["/usr/bin/fish"] }]), true);
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.closeStranded(candidate(["w1:p1"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2: HerdrHerd.strandedCandidates — a PRE-EXISTING stranded workspace is
// found by a fresh HerdrHerd instance that never spawned it itself, i.e.
// reclamation is not keyed on anything butchr remembers in memory.
// ---------------------------------------------------------------------------
describe("HerdrHerd.strandedCandidates", () => {
  test("finds a workspace this process never spawned — ownership is read fresh from herdr state, not from in-memory bookkeeping", async () => {
    const client = {
      workspace: { list: async () => ({ workspaces: [{ workspace_id: "w1", label: "BUTCHR-9" }] }) },
      pane: { list: async () => ({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] }) },
      agent: { list: async () => ({ agents: [] }) },
    } as any;
    // A BRAND NEW instance — spawn() was never called on it for BUTCHR-9 (or
    // anything else) in this process's lifetime.
    const herd = new HerdrHerd(client, "u");
    expect(await herd.strandedCandidates()).toEqual([{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }]);
  });

  test("FACTORY-92: a human-readable herdr label does not stop a pre-existing stranded workspace from being found and keyed on its REAL agent key", async () => {
    const client = {
      workspace: { list: async () => ({ workspaces: [{ workspace_id: "w1", label: "admin-assembly" }] }) },
      pane: { list: async () => ({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "jira-work", "task", "BUTCHR-9") }] }) },
      agent: { list: async () => ({ agents: [] }) },
    } as any;
    const herd = new HerdrHerd(client, "u");
    expect(await herd.strandedCandidates()).toEqual([{ workspaceId: "w1", label: "admin-assembly", agentKey: "jira-work:task:BUTCHR-9", paneIds: ["w1:p1"] }]);
  });
});

// ---------------------------------------------------------------------------
// 8 + orchestration: createReaper — per-poll gather/grace-filter/close, fault
// isolation, and the per-poll cap.
// ---------------------------------------------------------------------------
describe("createReaper", () => {
  function tickingNow(start: number) {
    let now = start;
    return { now: () => now, advance: (ms: number) => { now += ms; } };
  }

  test("the grace period holds end to end: not reaped on the first poll, reaped once two polls and 60s have both passed", async () => {
    const closes: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async (c) => { closes.push(c.workspaceId); return true; },
    });
    await reaper.check();
    expect(closes).toEqual([]);
    clock.advance(MIN);
    await reaper.check();
    expect(closes).toEqual(["w1"]);
  });

  test("a candidate that gains an agent between polls (drops out of the candidate set) is never reaped, even though it later reappears", async () => {
    const closes: string[] = [];
    const clock = tickingNow(0);
    let hasAgent = false;
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => (hasAgent ? [] : [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }]),
      close: async (c) => { closes.push(c.workspaceId); return true; },
    });
    await reaper.check(); // observation 1
    clock.advance(MIN / 2);
    hasAgent = true;
    await reaper.check(); // gained an agent — resets the tracker
    clock.advance(MIN / 2);
    hasAgent = false;
    await reaper.check(); // reappears — this is observation 1 of a fresh episode
    expect(closes).toEqual([]);
    clock.advance(MIN);
    await reaper.check(); // now observation 2, >= 60s since the fresh episode's start
    expect(closes).toEqual(["w1"]);
  });

  test("a live-but-unlisted agent is never reaped, this poll or any later poll, even once its grace period is long past", async () => {
    const closes: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => false, // stands in for closeStranded()'s verdict: live, never reaped
    });
    await reaper.check();
    clock.advance(MIN);
    await reaper.check();
    clock.advance(MIN * 10);
    await reaper.check();
    expect(closes).toEqual([]);
  });

  test("a failing close does not fail the poll, and does not prevent the other candidates from being closed", async () => {
    const closes: string[] = [];
    const logs: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [
        { workspaceId: "w1", label: "BUTCHR-1", agentKey: "BUTCHR-1", paneIds: ["w1:p1"] },
        { workspaceId: "w2", label: "BUTCHR-2", agentKey: "BUTCHR-2", paneIds: ["w2:p1"] },
      ],
      close: async (c) => {
        if (c.workspaceId === "w1") throw new Error("herdr hiccup closing w1");
        closes.push(c.workspaceId);
        return true;
      },
      log: (l) => logs.push(l),
    });
    await reaper.check();
    clock.advance(MIN);
    await reaper.check(); // both cleared their grace period on this poll
    expect(closes).toEqual(["w2"]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("w1"))).toBe(true);
    expect(logs.some((l) => l.includes("reclaimed workspace w2"))).toBe(true);
  });

  test("a candidates() gather failure degrades to reaped-nothing-this-poll — never throws", async () => {
    const reaper = createReaper({
      now: () => 0,
      candidates: async () => { throw new Error("herdr down"); },
      close: async () => true,
    });
    await expect(reaper.check()).resolves.toBeUndefined();
  });

  test("nothing eligible this poll → close is never called at all", async () => {
    let calls = 0;
    const reaper = createReaper({
      now: () => 0,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => { calls++; return true; },
    });
    await reaper.check(); // first observation only — not eligible yet
    expect(calls).toBe(0);
  });

  // BUTCHR-412, re-grounded by FACTORY-92.
  test("release is called with the candidate's REAL agentKey after a successful close", async () => {
    const released: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "jira-work:triage:BUTCHR-9", agentKey: "jira-work:triage:BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => true,
      release: async (agentKey) => { released.push(agentKey); },
    });
    await reaper.check();
    clock.advance(MIN);
    await reaper.check();
    expect(released).toEqual(["jira-work:triage:BUTCHR-9"]);
  });

  // FACTORY-92: this is the release call site's own regression test for the
  // ticket's core fix — release must key off `agentKey`, never `label`, so a
  // human-readable/renamed label (FACTORY-83's eventual change) never routes
  // release at the wrong Rocket.Chat account.
  test("FACTORY-92: release is called with the REAL agent key even when the herdr label is a different, human-readable string", async () => {
    const released: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "admin-assembly", agentKey: "jira-work:triage:BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => true,
      release: async (agentKey) => { released.push(agentKey); },
    });
    await reaper.check();
    clock.advance(MIN);
    await reaper.check();
    expect(released).toEqual(["jira-work:triage:BUTCHR-9"]);
    expect(released).not.toContain("admin-assembly");
  });

  test("release is never called for a candidate that was NOT actually closed (verified live/unknown)", async () => {
    const released: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => false,
      release: async (agentKey) => { released.push(agentKey); },
    });
    await reaper.check();
    clock.advance(MIN * 10);
    await reaper.check();
    expect(released).toEqual([]);
  });

  test("a release failure is logged and swallowed — never fails the poll or the reclaim count", async () => {
    const logs: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async () => true,
      release: async () => { throw new Error("RC unreachable"); },
      log: (l) => logs.push(l),
    });
    await reaper.check();
    clock.advance(MIN);
    await expect(reaper.check()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("reclaimed workspace w1"))).toBe(true);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("account release failed"))).toBe(true);
  });

  test("release omitted entirely: reaping still works exactly as before this ticket", async () => {
    const closes: string[] = [];
    const clock = tickingNow(0);
    const reaper = createReaper({
      now: clock.now,
      candidates: async () => [{ workspaceId: "w1", label: "BUTCHR-9", agentKey: "BUTCHR-9", paneIds: ["w1:p1"] }],
      close: async (c) => { closes.push(c.workspaceId); return true; },
    });
    await reaper.check();
    clock.advance(MIN);
    await reaper.check();
    expect(closes).toEqual(["w1"]);
  });
});
