import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { startManagedSessionsLoop, MANAGED_SESSIONS_RESTORE_SETTLE_SCOPE } from "../../src/daemon/session-definitions-loop.js";
import { RestoreSettleGate } from "../../src/agents/restore-settle.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { ensureWorkspaceDir, persistDiscoveredSessionId } from "../../src/agents/workspace.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";

/**
 * FACTORY-714/FACTORY-713/FACTORY-704 (reopened) acceptance items 1 and 3 —
 * the REQUIRED proof (same shape as FACTORY-501's/FACTORY-505's own, in the
 * sibling test files in this directory) that `RestoreSettleGate` is
 * reachable on the MANAGED-SESSION path THROUGH `startManagedSessionsLoop`
 * ITSELF (production code, unmodified here), not merely on `reconcileNow`
 * fed a gate directly — a test that only does the latter would pass even if
 * `ManagedSessionsLoopDeps.restoreSettleGate` were never threaded through
 * to `runResourceLoop` at all, which is exactly the FACTORY-704 (reopened)
 * defect this ticket fixes.
 *
 * GO RED FIRST (acceptance item 3): the fake herdr below lists `buddy`'s
 * restored pane LATE — a real resumable transcript is pre-seeded on disk
 * (real `hasResumableTranscript`, not an injected seam — acceptance item
 * 4) BEFORE `herd.running` ever contains the id. Before this ticket's fix
 * (no `restoreSettleGate` field on `ManagedSessionsLoopDeps`, nothing
 * passed to `runResourceLoop`), `buddy` would fresh-spawn on the very first
 * poll — see the sibling "red" test below, which asserts exactly that by
 * constructing the loop WITHOUT the gate wired, proving the field is
 * load-bearing rather than a no-op default.
 */

const res = (path: string): FilesystemResource => ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000 });

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A controllable fake herdr whose pane listing is late — mutated between polls, same shape as restore-settle.test.ts's own fakeHerd. */
function fakeHerd(): Herd & { running: Set<string>; spawned: string[] } {
  const spawned: string[] = [];
  const state = {
    running: new Set<string>(),
    spawned,
    async runningIssues() { return [...state.running]; },
    async staleIssues() { return []; },
    async spawn(sp: SpawnSpec) { spawned.push(sp.key); state.running.add(sp.key); },
    async stop(i: string) { state.running.delete(i); },
    async paneFor(i: string) { return state.running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
    async resumeInPlace() { return "unresumable" as const; },
  };
  return state;
}

describe("startManagedSessionsLoop + RestoreSettleGate (FACTORY-714/FACTORY-713/FACTORY-704 reopened)", () => {
  test("RED (gate NOT wired, today's pre-fix shape): a managed session with a real resumable transcript is fresh-spawned anyway, before herdr lists it", async () => {
    const root = mkdtempSync(join(tmpdir(), "restore-settle-ms-workspaces-"));
    const prevWorkspaces = process.env.BUTCHR_WORKSPACES;
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/buddy.json" });
      ensureWorkspaceDir(agentKey, root); // a real per-key workspace dir exists, same as production — irrelevant here since the gate is never consulted at all without this ticket's fix.

      const herd = fakeHerd(); // herdr has listed NOTHING yet — the restore-not-settled hazard

      const stop = startManagedSessionsLoop({
        root: "/defs",
        herd,
        deliver: async () => {},
        list: async () => [res("/defs/buddy.json")],
        read: async () => JSON.stringify(goodDef()),
        log: () => {},
        intervalMs: 5,
        // restoreSettleGate DELIBERATELY OMITTED — today's pre-FACTORY-714 shape.
      });

      await waitFor(() => herd.spawned.length > 0);
      stop();

      expect(herd.spawned).toEqual([agentKey]); // fresh-spawned with no settle gate at all — the FACTORY-704 (reopened) defect
    } finally {
      process.env.BUTCHR_WORKSPACES = prevWorkspaces;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GREEN: with restoreSettleGate wired through, a managed session with a real resumable transcript is held — never fresh-spawned — until herdr's restore settles, then resumed", async () => {
    const root = mkdtempSync(join(tmpdir(), "restore-settle-ms-workspaces-"));
    const prevWorkspaces = process.env.BUTCHR_WORKSPACES;
    process.env.BUTCHR_WORKSPACES = root;
    // `hasResumableTranscript` (the REAL implementation, not an injected
    // seam — acceptance item 4) calls `claudeTranscriptExists` with NO
    // `home` override, defaulting to `os.homedir()`. Bun caches that at
    // process start (process.env.HOME changes mid-test have no effect on
    // it, unlike Node) — so this test writes the transcript under the REAL
    // home's `.claude/projects/` tree, at a name derived from this test's
    // own mkdtemp'd workspace dir (collision-safe), and removes it in
    // `finally`.
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/buddy.json" });
    const dir = ensureWorkspaceDir(agentKey, root);
    const projectDir = join(homedir(), ".claude", "projects", resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
    try {
      const sessionId = "session-buddy-green";
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}");
      persistDiscoveredSessionId(dir, sessionId);

      const herd = fakeHerd();
      const logs: string[] = [];
      const gate = new RestoreSettleGate({ log: (l) => logs.push(l) });

      const stop = startManagedSessionsLoop({
        root: "/defs",
        herd,
        deliver: async () => {},
        list: async () => [res("/defs/buddy.json")],
        read: async () => JSON.stringify(goodDef()),
        log: () => {},
        intervalMs: 5,
        restoreSettleGate: gate, // THE LINE UNDER TEST
      });

      // A few polls pass with herdr still listing nothing — must stay held.
      await new Promise((r) => setTimeout(r, 30));
      expect(herd.spawned).toEqual([]); // not fresh-spawned — this is the proof the gate reached the managed-sessions path

      // herdr's restore now catches up: it lists buddy's pane (resumed outside this gate entirely, exactly like a real herdr-restored pane would).
      herd.running.add(agentKey);
      await waitFor(() => logs.some((l) => l.includes("resumed")));
      stop();

      expect(herd.spawned).toEqual([]); // never fresh-spawned — resumed, matching the "N resumed, M fresh" contract
      expect(logs).toContain(`[restore-settle:${MANAGED_SESSIONS_RESTORE_SETTLE_SCOPE}] 1 resumed, 0 fresh`);
    } finally {
      process.env.BUTCHR_WORKSPACES = prevWorkspaces;
      rmSync(root, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("negative control: a managed session with NO resumable transcript is never held, even with the gate wired", async () => {
    const root = mkdtempSync(join(tmpdir(), "restore-settle-ms-workspaces-"));
    const prevWorkspaces = process.env.BUTCHR_WORKSPACES;
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/plain.json" });
      const herd = fakeHerd();
      const gate = new RestoreSettleGate({});

      const stop = startManagedSessionsLoop({
        root: "/defs",
        herd,
        deliver: async () => {},
        list: async () => [res("/defs/plain.json")],
        read: async () => JSON.stringify(goodDef()),
        log: () => {},
        intervalMs: 5,
        restoreSettleGate: gate,
      });

      await waitFor(() => herd.spawned.length > 0);
      stop();

      expect(herd.spawned).toEqual([agentKey]); // no transcript on disk — nothing to lose, spawns immediately
    } finally {
      process.env.BUTCHR_WORKSPACES = prevWorkspaces;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
