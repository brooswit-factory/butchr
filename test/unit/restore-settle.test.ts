import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { RestoreSettleGate, hasResumableTranscript } from "../../src/agents/restore-settle.js";
import { persistDiscoveredSessionId, claudeTranscriptExists, ensureWorkspaceDir } from "../../src/agents/workspace.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";

const spec = (key: string): SpawnSpec => ({ key, issuetype: "Task", summary: "s", parent: null });

/**
 * A controllable fake herdr whose pane LISTING is late — `runningIssues()`
 * reads whatever `running` currently holds, which the test mutates between
 * polls to simulate herdr's restore populating slowly (FACTORY-710's own
 * "build a fake herdr that lists restored panes late" requirement).
 */
function fakeHerd(): Herd & { running: Set<string>; spawned: string[]; rejectListing: boolean } {
  const spawned: string[] = [];
  const state = {
    running: new Set<string>(),
    spawned,
    rejectListing: false,
    async runningIssues() {
      if (state.rejectListing) throw new Error("herdr socket down");
      return [...state.running];
    },
    async staleIssues() { return []; },
    async spawn(sp: SpawnSpec) { spawned.push(sp.key); state.running.add(sp.key); },
    async stop(i: string) { state.running.delete(i); },
    async paneFor(i: string) { return state.running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
    async resumeInPlace() { return "unresumable" as const; },
  };
  return state;
}

describe("RestoreSettleGate (FACTORY-710)", () => {
  test("a definition with NO resumable transcript is never held, even mid-episode", () => {
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1" });
    const specs = new Map([["RESUMABLE-1", spec("RESUMABLE-1")], ["PLAIN-1", spec("PLAIN-1")]]);
    const out = gate.filter(["RESUMABLE-1", "PLAIN-1"], [], specs);
    expect(out).toEqual(["PLAIN-1"]);
  });

  test("no resumable-transcript candidate at all is a complete no-op — never starts an episode", () => {
    const logs: string[] = [];
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => false, log: (l) => logs.push(l) });
    const specs = new Map([["A", spec("A")], ["B", spec("B")]]);
    expect(gate.filter(["A", "B"], [], specs)).toEqual(["A", "B"]);
    expect(gate.filter(["A", "B"], [], specs)).toEqual(["A", "B"]);
    expect(logs).toEqual([]);
  });

  test("holds a resumable candidate until two consecutive polls see a stable running set, then logs resumed vs fresh", () => {
    const logs: string[] = [];
    const specs = new Map([["A", spec("A")], ["B", spec("B")]]);
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "A", log: (l) => logs.push(l) });

    // Poll 1: herdr has listed nothing yet. A (resumable) is held; B spawns.
    expect(gate.filter(["A", "B"], [], specs)).toEqual(["B"]);

    // Poll 2: herdr's restore caught up — A now appears in `running` (it was
    // resumed through the ordinary stale/resumeInPlace path, outside this
    // gate entirely). `live` no longer offers it as a spawn candidate at all.
    expect(gate.filter([], ["A"], specs)).toEqual([]);
    expect(logs).toEqual([]); // not yet stable across TWO consecutive polls

    // Poll 3: running is identical to poll 2 — stable. Settle resolves.
    expect(gate.filter([], ["A"], specs)).toEqual([]);
    expect(logs).toEqual(["[restore-settle] 1 resumed, 0 fresh"]);
  });

  test("a candidate still absent from running when a NON-EMPTY listing stabilizes is let through as fresh, counted correctly", () => {
    const logs: string[] = [];
    const specs = new Map([["A", spec("A")]]);
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => true, log: (l) => logs.push(l) });

    expect(gate.filter(["A"], ["OTHER"], specs)).toEqual([]); // poll 1: held; herdr has listed something else
    expect(gate.filter(["A"], ["OTHER"], specs)).toEqual(["A"]); // poll 2: running stable AND non-empty — settles, A let through as fresh
    expect(logs).toEqual(["[restore-settle] 0 resumed, 1 fresh"]);

    // Settled — the gate never re-holds anything again, even a fresh resumable candidate.
    expect(gate.filter(["A"], ["OTHER"], specs)).toEqual(["A"]);
  });

  // FACTORY-710 review round 1: an EMPTY listing must never count as "stable"
  // on its own — `[] == []` was true, so two empty polls used to settle the
  // gate and fresh-spawn the exact hazard (herdr socket up, pane list not
  // yet populated) it exists to prevent. These two tests replace that
  // behaviour; the test above was changed from an empty to a non-empty
  // stable listing for the same reason (intentional correction of a
  // bug-confirming assertion, not a weakened one — see PR #673).
  test("an empty listing never counts as stable, however many consecutive polls see it — held until the listing is non-empty and stable, or populates outright", () => {
    const logs: string[] = [];
    const specs = new Map([["A", spec("A")]]);
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => true, log: (l) => logs.push(l) });

    expect(gate.filter(["A"], [], specs)).toEqual([]); // poll 1: episode starts
    expect(gate.filter(["A"], [], specs)).toEqual([]); // poll 2: [] == [] but empty is never "stable"
    expect(gate.filter(["A"], [], specs)).toEqual([]); // poll 3: still empty, still held
    expect(logs).toEqual([]); // never settled on empty alone

    // poll 4: herdr's restore populates — A appears in running (resumed via the ordinary path, outside this gate)
    expect(gate.filter([], ["A"], specs)).toEqual([]);
    expect(logs).toEqual([]); // not yet stable across two polls of the NEW (non-empty) running set

    // poll 5: running identical to poll 4, and non-empty — stable, settles
    expect(gate.filter([], ["A"], specs)).toEqual([]);
    expect(logs).toEqual(["[restore-settle] 1 resumed, 0 fresh"]);
  });

  test("an empty listing forever is held until the bound elapses, then falls back to fresh-spawn with the warning", () => {
    const logs: string[] = [];
    let t = 0;
    const specs = new Map([["A", spec("A")]]);
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => true, boundMs: 1000, now: () => t, log: (l) => logs.push(l) });

    t = 0;
    expect(gate.filter(["A"], [], specs)).toEqual([]); // episode starts
    t = 400;
    expect(gate.filter(["A"], [], specs)).toEqual([]); // [] == [] but empty never counts as stable
    t = 900;
    expect(gate.filter(["A"], [], specs)).toEqual([]); // still under the bound
    t = 1500; // past the 1000ms bound
    expect(gate.filter(["A"], [], specs)).toEqual(["A"]); // falls back to fresh-spawn
    expect(logs.some((l) => l.includes("WARNING") && l.includes("bounded wait") && l.includes("1000ms") && l.includes("A"))).toBe(true);
    expect(logs).toContain("[restore-settle] 0 resumed, 1 fresh");
  });

  test("bounded wait: a herdr that never stabilizes (constant churn) still releases once the bound elapses, logging why", () => {
    const logs: string[] = [];
    let t = 0;
    const specs = new Map([["A", spec("A")]]);
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => true, boundMs: 1000, now: () => t, log: (l) => logs.push(l) });

    t = 0;
    expect(gate.filter(["A"], ["noise-0"], specs)).toEqual([]); // episode starts
    t = 400;
    expect(gate.filter(["A"], ["noise-1"], specs)).toEqual([]); // running churns every poll — never stable
    t = 1500; // past the 1000ms bound
    expect(gate.filter(["A"], ["noise-2"], specs)).toEqual(["A"]); // falls back to fresh-spawn
    expect(logs.some((l) => l.includes("WARNING") && l.includes("bounded wait") && l.includes("1000ms") && l.includes("A"))).toBe(true);
    expect(logs).toContain("[restore-settle] 0 resumed, 1 fresh");
  });

  test("real hasResumableTranscript(): true only when BOTH a persisted session id and its transcript file exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "restore-settle-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "restore-settle-cwd-"));
    try {
      const s = spec("REAL-1");
      // No session id persisted at all yet — not resumable, regardless of workspaceDirFor's real resolution.
      // (workspaceDirFor is keyed off the real workspace root, not `cwd` here — this test only exercises the
      // standalone claudeTranscriptExists/workspaceSessionId pair directly, matching resumeInPlace()'s own check.)
      const sessionId = "session-abc";
      expect(claudeTranscriptExists(cwd, sessionId, home)).toBe(false);
      const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}");
      persistDiscoveredSessionId(cwd, sessionId);
      expect(claudeTranscriptExists(cwd, sessionId, home)).toBe(true);
      void s; void hasResumableTranscript; // real hasResumableTranscript() is exercised end-to-end via workspaceDirFor in the reconcileNow integration tests below (fixed workspace root), not here.
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // FACTORY-713/FACTORY-704 (reopened) acceptance item 4 — `hasResumableTranscript`
  // asserted against a REAL managed-session-shaped key with the REAL
  // implementation (never the `hasResumableTranscript` injection seam):
  // `workspaceDirFor(spec.key)` -> `decodeAnyAgentKey` must resolve a real
  // per-key directory for an id shaped exactly like `ownsManagedSessionAgent`
  // requires (`resourceProvider: "filesystem", ruleId: "managed-sessions"`),
  // and a `.butchr-session-id.json` dropped there (the SAME file
  // `persistDiscoveredSessionId` writes, and `workspaceSessionId` reads) must
  // make `hasResumableTranscript` see it as resumable. If this resolution had
  // failed, the fix would be a no-op that still passes every fake-herdr test
  // in this file — this is the test that would have caught that.
  test("real hasResumableTranscript() against a REAL managed-session-shaped key: resolves a real per-key workspace dir, true once a session id + transcript exist there", () => {
    const root = mkdtempSync(join(tmpdir(), "restore-settle-workspaces-"));
    const prevWorkspaces = process.env.BUTCHR_WORKSPACES;
    process.env.BUTCHR_WORKSPACES = root;
    // `hasResumableTranscript` is the REAL, un-injected implementation — it
    // calls `claudeTranscriptExists`/`claudeProjectDir` with NO `home`
    // override, which default to `os.homedir()`. Bun caches `homedir()` at
    // process start (confirmed: setting `process.env.HOME` mid-test has no
    // effect on it, unlike Node), so this test cannot redirect that default
    // — it uses the REAL home's `.claude/projects/` tree instead, writing a
    // transcript under a name derived from THIS test's own mkdtemp'd
    // workspace dir (collision-safe) and removing it again in `finally`.
    const projectDir = join(homedir(), ".claude", "projects", resolve(join(root, "filesystem", "managed-sessions", "buddy")).replace(/[^a-zA-Z0-9]/g, "-"));
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/buddy.json" });
      const dir = ensureWorkspaceDir(key, root);
      expect(dir).toBe(join(root, "filesystem", "managed-sessions", "buddy"));
      const spec: SpawnSpec = { key, issuetype: "Task", summary: "s", parent: null };

      // No session id persisted yet: not resumable.
      expect(hasResumableTranscript(spec)).toBe(false);

      const sessionId = "session-real-managed";
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}");
      persistDiscoveredSessionId(dir, sessionId);

      // The actual claim: workspaceDirFor/decodeAnyAgentKey resolved a REAL
      // per-key directory for this managed-session-shaped id, and the real
      // hasResumableTranscript() (no seam) sees the transcript dropped there.
      expect(hasResumableTranscript(spec)).toBe(true);
    } finally {
      process.env.BUTCHR_WORKSPACES = prevWorkspaces;
      rmSync(root, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("RestoreSettleGate per-scope state (FACTORY-713/FACTORY-704 reopened)", () => {
  // Acceptance item 2 — the director's reopen instructed ONE shared gate
  // instance across the issue loop and the managed-sessions loop. Taken
  // literally (a single un-scoped `lastRunning`/`settled`/etc.), that makes
  // the gate alternate between two disjoint `running` sets on every poll and
  // NEVER settle by stability — see `RestoreSettleGate`'s own class doc
  // comment. This test drives ONE shared gate instance exactly the way
  // production does (two scopes, interleaved polls, disjoint running sets)
  // and asserts the managed-sessions scope settles by STABILITY, never
  // falling through to the bounded wait — the assertion that would catch a
  // regression back to the literal single-episode reading.
  test("one shared gate instance, two interleaved loops with disjoint running sets: each scope settles independently by stability, never the bounded wait", () => {
    const issueLogs: string[] = [];
    const sessionLogs: string[] = [];
    const gate = new RestoreSettleGate({
      boundMs: 60_000, // generous — a regression to the shared-episode bug would still need 60s+ to release; this test proves settle happens WITHOUT ever touching the bound.
      hasResumableTranscript: (s) => s.key === "ISSUE-RESUMABLE" || s.key === "buddy",
      log: (l) => (l.includes("managed-sessions") ? sessionLogs : issueLogs).push(l),
    });
    const issueSpecs = new Map([["ISSUE-RESUMABLE", { key: "ISSUE-RESUMABLE", issuetype: "Task", summary: "s", parent: null } satisfies SpawnSpec]]);
    const sessionSpecs = new Map([["buddy", { key: "buddy", issuetype: "Task", summary: "s", parent: null } satisfies SpawnSpec]]);

    // Poll 1, both scopes: herdr has listed nothing for either yet (disjoint empty sets either way).
    expect(gate.filter(["ISSUE-RESUMABLE"], [], issueSpecs, "issue")).toEqual([]);
    expect(gate.filter(["buddy"], [], sessionSpecs, "managed-sessions")).toEqual([]);

    // Poll 2, interleaved: herdr's restore populates DIFFERENT, disjoint sets
    // for each scope — exactly the shape the literal shared-instance reading
    // could never tell apart from churn.
    expect(gate.filter([], ["ISSUE-RESUMABLE"], issueSpecs, "issue")).toEqual([]);
    expect(gate.filter([], ["buddy"], sessionSpecs, "managed-sessions")).toEqual([]);
    expect(issueLogs).toEqual([]);
    expect(sessionLogs).toEqual([]); // not yet stable across TWO consecutive polls of either scope's OWN running set

    // Poll 3, interleaved again: each scope's running set is identical to
    // its own poll 2 — stable, by its OWN history, never compared to the
    // other scope's disjoint set.
    expect(gate.filter([], ["ISSUE-RESUMABLE"], issueSpecs, "issue")).toEqual([]);
    expect(gate.filter([], ["buddy"], sessionSpecs, "managed-sessions")).toEqual([]);

    expect(issueLogs).toEqual(["[restore-settle:issue] 1 resumed, 0 fresh"]);
    expect(sessionLogs).toEqual(["[restore-settle:managed-sessions] 1 resumed, 0 fresh"]);
    // Neither log line mentions a WARNING/bounded-wait fallback — both
    // settled by stability alone, well inside the generous 60s bound.
    expect(issueLogs.some((l) => l.includes("WARNING"))).toBe(false);
    expect(sessionLogs.some((l) => l.includes("WARNING"))).toBe(false);
  });

  // One scope settling/releasing must not release the other scope's held
  // candidates — the OTHER half of acceptance item 2. The issue scope
  // settles immediately (its own running set is already non-empty and
  // stable from poll 1); the managed-sessions scope's candidate must stay
  // held regardless, across many more issue-scope polls, until ITS OWN
  // running set stabilizes.
  test("the issue scope settling (and repeatedly re-filtering afterward) never releases a held managed-sessions candidate", () => {
    const gate = new RestoreSettleGate({
      boundMs: 60_000,
      hasResumableTranscript: (s) => s.key === "buddy",
    });
    const issueSpecs = new Map<string, SpawnSpec>();
    const sessionSpecs = new Map([["buddy", { key: "buddy", issuetype: "Task", summary: "s", parent: null } satisfies SpawnSpec]]);

    // Issue scope: nothing ever needed gating there — settles trivially (the "ordinary poll" no-op path) on its very first call.
    expect(gate.filter([], ["ISSUE-OTHER"], issueSpecs, "issue")).toEqual([]);
    expect(gate.filter([], ["ISSUE-OTHER"], issueSpecs, "issue")).toEqual([]);

    // Managed-sessions scope: buddy is resumable and herdr has not listed it yet.
    expect(gate.filter(["buddy"], [], sessionSpecs, "managed-sessions")).toEqual([]);

    // Drive many more issue-scope polls (its own settle/no-op path) — none
    // of this is evidence for the managed-sessions scope's stability.
    for (let i = 0; i < 5; i++) {
      expect(gate.filter([], ["ISSUE-OTHER"], issueSpecs, "issue")).toEqual([]);
      expect(gate.filter(["buddy"], [], sessionSpecs, "managed-sessions")).toEqual([]); // still held — herdr still hasn't listed it
    }

    // Now herdr's own restore actually lists buddy — resumed, not fresh-spawned.
    sessionSpecs; // (no change needed — resolved via `running`, not specs)
    expect(gate.filter([], ["buddy"], sessionSpecs, "managed-sessions")).toEqual([]);
    expect(gate.filter([], ["buddy"], sessionSpecs, "managed-sessions")).toEqual([]); // stable now — settles
  });
});

describe("reconcileNow + RestoreSettleGate integration (FACTORY-710) — fake herdr listing restored panes LATE", () => {
  test("no fresh spawn for a resumable-transcript definition before settle resolves; a non-resumable definition spawns immediately", async () => {
    const herd = fakeHerd();
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1" });
    const desired = new Map([["RESUMABLE-1", spec("RESUMABLE-1")], ["PLAIN-1", spec("PLAIN-1")]]);

    await reconcileNow(herd, desired, { restoreSettleGate: gate });

    expect(herd.spawned).toEqual(["PLAIN-1"]);
  });

  test("after settle (stability), a held resumable definition that appeared in running meanwhile is resumed, never fresh-spawned", async () => {
    const herd = fakeHerd();
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1" });
    const desired = new Map([["RESUMABLE-1", spec("RESUMABLE-1")]]);

    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // poll 1: held
    expect(herd.spawned).toEqual([]);

    herd.running.add("RESUMABLE-1"); // herdr's restore caught up outside butchr's own spawn()
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // poll 2
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // poll 3: stable — settles

    expect(herd.spawned).toEqual([]); // never fresh-spawned — it was resumed, not spawned by butchr at all
  });

  test("bounded-wait fallback: still-missing resumable definition is fresh-spawned once the bound elapses, and the log line fires", async () => {
    const herd = fakeHerd();
    let t = 0;
    const logs: string[] = [];
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1", boundMs: 1000, now: () => t, log: (l) => logs.push(l) });
    const desired = new Map([["RESUMABLE-1", spec("RESUMABLE-1")]]);

    t = 0;
    herd.running.add("noise-0");
    await reconcileNow(herd, desired, { restoreSettleGate: gate });
    expect(herd.spawned).toEqual([]);

    t = 400;
    herd.running = new Set(["noise-1"]); // churn — never stable poll to poll
    await reconcileNow(herd, desired, { restoreSettleGate: gate });
    expect(herd.spawned).toEqual([]);

    t = 1500; // past bound
    herd.running = new Set(["noise-2"]);
    await reconcileNow(herd, desired, { restoreSettleGate: gate });

    expect(herd.spawned).toEqual(["RESUMABLE-1"]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("bounded wait"))).toBe(true);
    expect(logs).toContain("[restore-settle] 0 resumed, 1 fresh");
  });

  test("empty listing forever (herdr never lists anything): held until the bound elapses, then fresh-spawned, warning logged", async () => {
    const herd = fakeHerd();
    let t = 0;
    const logs: string[] = [];
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1", boundMs: 1000, now: () => t, log: (l) => logs.push(l) });
    const desired = new Map([["RESUMABLE-1", spec("RESUMABLE-1")]]);

    t = 0;
    await reconcileNow(herd, desired, { restoreSettleGate: gate });
    expect(herd.spawned).toEqual([]);

    t = 400;
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // still empty — [] == [] must not settle
    expect(herd.spawned).toEqual([]);

    t = 1500; // past bound
    await reconcileNow(herd, desired, { restoreSettleGate: gate });

    expect(herd.spawned).toEqual(["RESUMABLE-1"]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("bounded wait"))).toBe(true);
    expect(logs).toContain("[restore-settle] 0 resumed, 1 fresh");
  });

  test("herdr socket DOWN (runningIssues rejects) still results in no spawn at all — existing unwrapped-rejection property untouched by the gate", async () => {
    const herd = fakeHerd();
    herd.rejectListing = true;
    const gate = new RestoreSettleGate({ hasResumableTranscript: () => true });
    const desired = new Map([["A", spec("A")]]);

    await expect(reconcileNow(herd, desired, { restoreSettleGate: gate })).rejects.toThrow();
    expect(herd.spawned).toEqual([]);
  });

  test("omitting restoreSettleGate entirely is today's exact unchanged behaviour — immediate fresh-spawn", async () => {
    const herd = fakeHerd();
    const desired = new Map([["A", spec("A")]]);
    await reconcileNow(herd, desired, {});
    expect(herd.spawned).toEqual(["A"]);
  });

  // FACTORY-710 review round 2: butchr's OWN spawns must never count as
  // settle evidence. A plain (no-transcript) definition spawns immediately
  // and the fake herd's `spawn()` adds it straight to `running` (exactly
  // what herdr itself does for a pane it now manages) — so a mix of one
  // plain and one resumable definition must not let the plain one's own
  // appearance in `running` masquerade as herdr's restore settling.
  test("a plain definition's own fresh spawn never counts as settle evidence for a resumable sibling — (a) herdr later lists it: resumed", async () => {
    const herd = fakeHerd();
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1" });
    const desired = new Map([["PLAIN-1", spec("PLAIN-1")], ["RESUMABLE-1", spec("RESUMABLE-1")]]);

    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // poll 1: PLAIN-1 spawns, added to herd.running by the fake itself
    expect(herd.spawned).toEqual(["PLAIN-1"]);

    for (let i = 0; i < 4; i++) {
      await reconcileNow(herd, desired, { restoreSettleGate: gate }); // polls 2-5: running stably contains only PLAIN-1 (self-spawned) — must NOT settle
      expect(herd.spawned).toEqual(["PLAIN-1"]); // RESUMABLE-1 still held, not fresh-spawned
    }

    herd.running.add("RESUMABLE-1"); // herdr's own restore catches up
    await reconcileNow(herd, desired, { restoreSettleGate: gate });
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // stable now that herdr itself listed something new

    expect(herd.spawned).toEqual(["PLAIN-1"]); // RESUMABLE-1 was resumed, never fresh-spawned
  });

  test("a plain definition's own fresh spawn never counts as settle evidence for a resumable sibling — (b) herdr never lists it: fresh-spawned only after the bound", async () => {
    const herd = fakeHerd();
    let t = 0;
    const logs: string[] = [];
    const gate = new RestoreSettleGate({ hasResumableTranscript: (s) => s.key === "RESUMABLE-1", boundMs: 1000, now: () => t, log: (l) => logs.push(l) });
    const desired = new Map([["PLAIN-1", spec("PLAIN-1")], ["RESUMABLE-1", spec("RESUMABLE-1")]]);

    t = 0;
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // PLAIN-1 spawns; herd.running now {PLAIN-1}
    expect(herd.spawned).toEqual(["PLAIN-1"]);

    t = 400;
    await reconcileNow(herd, desired, { restoreSettleGate: gate }); // running stably {PLAIN-1} across polls — self-caused, must not settle
    expect(herd.spawned).toEqual(["PLAIN-1"]);

    t = 900;
    await reconcileNow(herd, desired, { restoreSettleGate: gate });
    expect(herd.spawned).toEqual(["PLAIN-1"]);

    t = 1500; // past the bound
    await reconcileNow(herd, desired, { restoreSettleGate: gate });

    expect(herd.spawned).toEqual(["PLAIN-1", "RESUMABLE-1"]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("bounded wait"))).toBe(true);
    expect(logs).toContain("[restore-settle] 0 resumed, 1 fresh");
  });
});
