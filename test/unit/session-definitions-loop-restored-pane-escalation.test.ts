import { describe, expect, test } from "bun:test";
import { startManagedSessionsLoop } from "../../src/daemon/session-definitions-loop.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { createRestoredPaneEscalationDetector } from "../../src/agents/restored-pane-escalation.js";
import { RESTORED_PANE_STALE_REASON_PREFIX } from "../../src/agents/herd.js";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";

/**
 * FACTORY-501 — the REQUIRED proof (FACTORY-500's own correction) that the
 * restored-pane escalation is reachable on the MANAGED-SESSION path, not
 * merely on `reconcileNow` fed a hook directly by the test. `buddy`/`genius`
 * (the canary set) are managed sessions started via
 * `startManagedSessionsLoop` (src/daemon/session-definitions-loop.ts) — the
 * SAME wiring `onResumeWaiting`/`onResumePreserved` were found to be absent
 * from. This test calls `startManagedSessionsLoop` itself (production code,
 * unmodified) with a real `createRestoredPaneEscalationDetector` instance —
 * exactly the shape `src/daemon/index.ts` wires — and asserts the
 * detector's `addComment` actually fires once the injected clock crosses
 * the threshold. If session-definitions-loop.ts's own
 * `...(deps.checkRestoredPaneDeferred ? { checkRestoredPaneDeferred: ... } : {})`
 * line were ever removed, `reconcileNow` inside `runResourceLoop` would
 * never receive the hook and this test would fail (the escalation would
 * simply never post) — unlike a test that hands `checkRestoredPaneDeferred`
 * straight to `reconcileNow`, which only proves loop.ts's own plumbing, not
 * that this file actually wires it through.
 */

const res = (path: string): FilesystemResource => ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000 });

const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 40));
const MIN = 60_000;

describe("startManagedSessionsLoop: FACTORY-501 restored-pane escalation is reachable for a managed-session agent (buddy/genius shape)", () => {
  test("a managed-session agent stuck restored-pane-deferred escalates through the REAL production wiring — addComment fires at the wall-clock threshold", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/buddy.json" });
    let now = 0;
    const running = new Set([agentKey]);
    const spawned: SpawnSpec[] = [];
    const stopped: string[] = [];
    const resumeCalls: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() {
        return [...running].map((issue) => ({
          issue,
          reason: `${RESTORED_PANE_STALE_REASON_PREFIX} after a host reset as a bare \`claude --resume\` (--mcp-config) — relaunching on the same session with butchr's full flag set`,
          observedArgv: ["claude", "--resume", "some-session-id"],
          resumable: true,
        }));
      },
      async spawn(sp) { spawned.push(sp); running.add(sp.key); },
      async stop(i) { stopped.push(i); running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace(sp) { resumeCalls.push(sp.key); return "deferred" as const; },
    };

    const posted: Array<{ id: string; text: string }> = [];
    const logs: string[] = [];
    // The SAME detector shape src/daemon/index.ts constructs for the
    // managed-session path (no Jira ticket — addComment is a plain
    // recorder here, standing in for that file's journal-log fallback).
    const detector = createRestoredPaneEscalationDetector({
      now: () => now,
      addComment: async (id, text) => { posted.push({ id, text }); },
      log: (l) => logs.push(l),
      firstThresholdMs: 10 * MIN,
      repeatIntervalMs: 60 * MIN,
    });

    const stop = startManagedSessionsLoop({
      root: "/defs",
      herd,
      deliver: async () => {},
      list: async () => [res("/defs/buddy.json")],
      read: async () => JSON.stringify(goodDef()),
      log: (l) => logs.push(l),
      intervalMs: 5,
      // THE LINE UNDER TEST: without ManagedSessionsLoopDeps threading this
      // to runResourceLoop's GenericLoopDeps, the detector below is
      // constructed but never actually invoked by a poll.
      checkRestoredPaneDeferred: detector.check,
    });

    await tick(); // poll(s): deferred, elapsed still under the threshold — not due
    expect(posted).toEqual([]);
    expect(resumeCalls.length).toBeGreaterThan(0);
    expect(resumeCalls.every((k) => k === agentKey)).toBe(true); // resumeInPlace was actually reached for this managed-session id

    now = 10 * MIN; // cross the first threshold before the next poll
    await tick();
    stop();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.id).toBe(agentKey);
    expect(posted[0]!.text).toContain("DEGRADED");
    // Never a stop/spawn on this path, however the poll landed.
    expect(stopped).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("negative control: the SAME scenario with checkRestoredPaneDeferred omitted from the deps never escalates — proves the field is load-bearing, not a no-op default", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/genius.json" });
    let now = 0;
    const running = new Set([agentKey]);
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() {
        return [...running].map((issue) => ({
          issue,
          reason: `${RESTORED_PANE_STALE_REASON_PREFIX} after a host reset as a bare \`claude --resume\` (--mcp-config) — relaunching on the same session with butchr's full flag set`,
          observedArgv: ["claude", "--resume", "some-session-id"],
          resumable: true,
        }));
      },
      async spawn(sp) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace() { return "deferred" as const; },
    };
    const posted: Array<{ id: string; text: string }> = [];
    const detector = createRestoredPaneEscalationDetector({
      now: () => now, addComment: async (id, text) => { posted.push({ id, text }); }, firstThresholdMs: 10 * MIN, repeatIntervalMs: 60 * MIN,
    });

    const stop = startManagedSessionsLoop({
      root: "/defs", herd, deliver: async () => {},
      list: async () => [res("/defs/genius.json")],
      read: async () => JSON.stringify(goodDef()),
      log: () => {}, intervalMs: 5,
      // checkRestoredPaneDeferred deliberately OMITTED — `detector.check` is never called by anything.
    });
    await tick();
    now = 100 * MIN; // far past the threshold
    await tick();
    stop();
    expect(posted).toEqual([]); // detector exists but was never wired in — nothing ever called it
  });
});
