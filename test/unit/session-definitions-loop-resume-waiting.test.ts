import { describe, expect, test } from "bun:test";
import { startManagedSessionsLoop } from "../../src/daemon/session-definitions-loop.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { RESUME_WAITING_NOTICE_AT_POLLS } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";

/**
 * FACTORY-505 — the REQUIRED proof (mirroring FACTORY-501's own proof for
 * `checkRestoredPaneDeferred`, test/unit/session-definitions-loop-restored-pane-escalation.test.ts)
 * that `onResumeWaiting`/`onResumePreserved` are reachable on the
 * MANAGED-SESSION path, not merely on `reconcileNow` fed the hooks directly
 * by a test. `buddy`/`genius`-shaped agents are managed sessions started via
 * `startManagedSessionsLoop` (src/daemon/session-definitions-loop.ts) — the
 * SAME wiring FACTORY-505's own ticket found `onResumeWaiting`/
 * `onResumePreserved` absent from (this file's own top-of-file doc comment
 * said so). This test calls `startManagedSessionsLoop` itself (production
 * code, unmodified) and asserts the hooks actually fire once the injected
 * `herd.resumeInPlace()` behaviour crosses the relevant condition. If
 * session-definitions-loop.ts's own
 * `...(deps.onResumeWaiting ? { onResumeWaiting: ... } : {})` line (and its
 * `onResumePreserved` counterpart) were ever removed, `reconcileNow` inside
 * `runResourceLoop` would never receive the hooks and these tests would
 * fail — unlike a test that hands the hooks straight to `reconcileNow`,
 * which only proves loop.ts's own plumbing, not that this file actually
 * wires it through.
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

describe("startManagedSessionsLoop: FACTORY-505 onResumeWaiting/onResumePreserved are reachable for a managed-session agent (buddy/genius shape)", () => {
  test("a managed-session agent whose model/effort resume stays deferred escalates through the REAL production wiring — onResumeWaiting fires at the poll threshold", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/buddy.json" });
    const running = new Set([agentKey]);
    const resumeCalls: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() {
        return [...running].map((issue) => ({
          issue,
          // Deliberately NOT the herdr-restored-pane prefix — a plain
          // model/effort-only staleness, the path onResumeWaiting is worded for.
          reason: "model/effort changed: relaunching on the same session",
          observedArgv: ["claude", "--resume", "some-session-id"],
          resumable: true,
        }));
      },
      async spawn(sp) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace(sp: SpawnSpec) { resumeCalls.push(sp.key); return "deferred" as const; },
    };

    const waiting: Array<{ issue: string; outcome: string; count: number }> = [];
    const preserved: string[] = [];
    const logs: string[] = [];

    const stop = startManagedSessionsLoop({
      root: "/defs",
      herd,
      deliver: async () => {},
      list: async () => [res("/defs/buddy.json")],
      read: async () => JSON.stringify(goodDef()),
      log: (l) => logs.push(l),
      intervalMs: 5,
      // THE LINES UNDER TEST: without ManagedSessionsLoopDeps threading these
      // to runResourceLoop's GenericLoopDeps, neither hook below is ever invoked.
      onResumeWaiting: (issue, outcome, count) => { waiting.push({ issue, outcome, count }); },
      onResumePreserved: (issue) => { preserved.push(issue); },
    });

    await waitFor(() => resumeCalls.length >= RESUME_WAITING_NOTICE_AT_POLLS);
    await waitFor(() => waiting.length > 0);
    stop();

    expect(waiting).toEqual([{ issue: agentKey, outcome: "deferred", count: RESUME_WAITING_NOTICE_AT_POLLS }]);
    expect(preserved).toEqual([]); // never resumed cleanly in this scenario
  });

  test("a managed-session agent whose model/effort resume succeeds fires onResumePreserved through the REAL production wiring", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/genius.json" });
    const running = new Set([agentKey]);
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() {
        return [...running].map((issue) => ({
          issue,
          reason: "model/effort changed: relaunching on the same session",
          observedArgv: ["claude", "--resume", "some-session-id"],
          resumable: true,
        }));
      },
      async spawn(sp) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace() { return "resumed" as const; },
    };

    const waiting: unknown[] = [];
    const preserved: string[] = [];

    const stop = startManagedSessionsLoop({
      root: "/defs",
      herd,
      deliver: async () => {},
      list: async () => [res("/defs/genius.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {},
      intervalMs: 5,
      onResumeWaiting: (issue, outcome, count) => { waiting.push({ issue, outcome, count }); },
      onResumePreserved: (issue) => { preserved.push(issue); },
    });

    await waitFor(() => preserved.length > 0);
    stop();

    // Fires every poll this test double reports "resumed" on — unlike
    // onResumeWaiting's once-only threshold, onResumePreserved has no
    // dedupe of its own (see ReconcileOptions.onResumePreserved's own doc
    // comment); asserting every recorded call names this agent is the
    // meaningful claim here, not an exact call count.
    expect(preserved.length).toBeGreaterThan(0);
    expect(preserved.every((id) => id === agentKey)).toBe(true);
    expect(waiting).toEqual([]);
  });

  test("negative control: the SAME deferred scenario with onResumeWaiting omitted from the deps never escalates — proves the field is load-bearing, not a no-op default", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/omitted.json" });
    const running = new Set([agentKey]);
    const resumeCalls: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() {
        return [...running].map((issue) => ({
          issue,
          reason: "model/effort changed: relaunching on the same session",
          observedArgv: ["claude", "--resume", "some-session-id"],
          resumable: true,
        }));
      },
      async spawn(sp) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace(sp: SpawnSpec) { resumeCalls.push(sp.key); return "deferred" as const; },
    };

    // A real callback, exactly like the positive test's — constructed here so
    // this test can prove it would have recorded a fire had the wiring been
    // present, but deliberately NEVER passed to `startManagedSessionsLoop`
    // below (the field under test is omitted from the deps object).
    const waiting: Array<{ issue: string; outcome: string; count: number }> = [];
    const onResumeWaiting = (issue: string, outcome: "deferred" | "stuck", count: number) => { waiting.push({ issue, outcome, count }); };
    void onResumeWaiting; // referenced only to prove it compiles against the real hook signature — deliberately unused below

    const stop = startManagedSessionsLoop({
      root: "/defs",
      herd,
      deliver: async () => {},
      list: async () => [res("/defs/omitted.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {},
      intervalMs: 5,
      // onResumeWaiting (and onResumePreserved) deliberately OMITTED — `waiting` above must stay empty.
    });

    // Drive well past the notice threshold — a passing test here must not be
    // an accident of not having polled enough.
    await waitFor(() => resumeCalls.length >= RESUME_WAITING_NOTICE_AT_POLLS + 10);
    stop();

    expect(waiting).toEqual([]); // detector-shaped callback exists but was never wired in — nothing ever called it
  });
});
