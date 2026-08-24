import { describe, expect, test } from "bun:test";
import { reconcileNow, startLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async spawn(i) { spawned.push(i); running.add(i); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
  };
}
const iss = (key: string, status: string): JiraIssue => ({ key, status, summary: "s", issuetype: "Task", assignee: "a", updated: "t" });

describe("reconcileNow", () => {
  test("spawns active-not-running and stops running-not-active", async () => {
    const herd = fakeHerd(["OLD", "KEEP"]);
    await reconcileNow(herd, ["KEEP", "NEW"]);
    expect(herd.spawned).toEqual(["NEW"]);
    expect(herd.stopped).toEqual(["OLD"]);
    expect([...herd.running].sort()).toEqual(["KEEP", "NEW"]);
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
