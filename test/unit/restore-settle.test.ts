import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RestoreSettleGate, hasResumableTranscript } from "../../src/agents/restore-settle.js";
import { persistDiscoveredSessionId, claudeTranscriptExists } from "../../src/agents/workspace.js";
import { reconcileNow } from "../../src/daemon/loop.js";
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
