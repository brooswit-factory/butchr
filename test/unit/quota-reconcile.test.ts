import { expect, test } from "bun:test";
import { reconcileNow, scopedHerd } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";

test("quota recovery passes through the scoped herd before fresh state is read", async () => {
  const calls: string[] = [];
  const herd: Herd = {
    recoverQuota: async (spec) => { calls.push(`recover:${spec.key}`); return "recovered"; },
    runningIssues: async () => { calls.push("running"); return ["KAN-1"]; },
    staleIssues: async () => { calls.push("stale"); return []; },
    spawn: async () => { calls.push("spawn"); },
    stop: async () => {},
    paneFor: async () => null,
    nudge: async () => ({ delivered: false }),
  };
  await reconcileNow(scopedHerd(herd, (id) => id === "KAN-1"), new Map([["KAN-1", { key: "KAN-1", issuetype: "task", summary: "", parent: null }]]));
  expect(calls[0]).toBe("recover:KAN-1");
  expect(calls).not.toContain("spawn");
});

test("one quota recovery failure does not prevent another workspace from spawning", async () => {
  const spawned: string[] = [];
  const herd: Herd = {
    recoverQuota: async (spec) => { if (spec.key === "KAN-1") throw new Error("read failed"); return "not-refused"; },
    runningIssues: async () => ["KAN-1"],
    staleIssues: async () => [],
    spawn: async (spec) => { spawned.push(spec.key); },
    stop: async () => {}, paneFor: async () => null, nudge: async () => ({ delivered: false }),
  };
  await reconcileNow(herd, new Map(["KAN-1", "KAN-2"].map((key) => [key, { key, issuetype: "task", summary: "", parent: null }])));
  expect(spawned).toEqual(["KAN-2"]);
});
