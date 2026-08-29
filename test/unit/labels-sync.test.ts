import { describe, expect, test } from "bun:test";
import { createLabelSync, type LabelWriter } from "../../src/labels/sync.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const iss = (key: string, status: string, labels: string[]): JiraIssue =>
  ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: "t", labels });

function fakeJira(): LabelWriter & { calls: Array<{ key: string; add: string[]; remove: string[] }> } {
  const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
  return {
    calls,
    async updateLabels(key, ops) { calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] }); },
  };
}

function fakeJiraFailingFor(badKey: string): LabelWriter & { calls: Array<{ key: string; add: string[]; remove: string[] }> } {
  const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
  return {
    calls,
    async updateLabels(key, ops) {
      if (key === badKey) throw new Error("403 forbidden");
      calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
    },
  };
}

describe("createLabelSync", () => {
  test("working -> idle -> blocked -> none: each confirmed transition is exactly one Jira update", async () => {
    const jira = fakeJira();
    const agentStatus = { current: "working" as string | null };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentStatus.current ? [["KAN-1", agentStatus.current]] : []) });

    // the very first observation for a ticket applies immediately — nothing to flicker against yet
    let issue = iss("KAN-1", "In Progress", []);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);

    jira.calls.length = 0;
    agentStatus.current = "idle";
    issue = iss("KAN-1", "In Progress", ["agent:working"]);
    await sync([issue]); // 1st poll of "idle" vs applied "working": unconfirmed candidate, no write
    expect(jira.calls).toEqual([]);
    await sync([issue]); // 2nd consecutive poll of "idle": confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["agent:working"] }]);

    jira.calls.length = 0;
    agentStatus.current = "blocked";
    issue = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue]);
    expect(jira.calls).toEqual([]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:blocked"], remove: ["agent:idle"] }]);

    jira.calls.length = 0;
    agentStatus.current = null;
    issue = iss("KAN-1", "In Progress", ["agent:blocked"]);
    await sync([issue]);
    expect(jira.calls).toEqual([]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none"], remove: ["agent:blocked"] }]);
  });

  test("herdr's agent_status flickering within the stabilization window produces zero label churn", async () => {
    const jira = fakeJira();
    // never the same value twice in a row: working, blocked, working, blocked, working
    const statuses: Array<string | null> = ["working", "blocked", "working", "blocked", "working"];
    let i = 0;
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", statuses[Math.min(i++, statuses.length - 1)]!]]) });

    const issue = iss("KAN-1", "In Progress", ["agent:working"]); // already applied: working
    for (let p = 0; p < statuses.length; p++) await sync([issue]);
    expect(jira.calls).toEqual([]); // every candidate reverted before confirming — zero writes
  });

  test("a genuinely stable transition (new status held for 2 consecutive polls) still produces exactly one add/remove pair", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "blocked"]]) });
    const issue = iss("KAN-1", "In Progress", ["agent:working"]);
    await sync([issue]); // poll 1 of "blocked": unconfirmed
    expect(jira.calls).toEqual([]);
    await sync([issue]); // poll 2 of "blocked": confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:blocked"], remove: ["agent:working"] }]);
    jira.calls.length = 0;
    await sync([iss("KAN-1", "In Progress", ["agent:blocked"])]); // now matches applied: no further writes
    expect(jira.calls).toEqual([]);
  });

  test("human labels are never added or removed, and survive reconciliation", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    const issue = iss("KAN-1", "In Progress", ["agent:working", "urgent", "needs-design"]);
    await sync([issue]); // unconfirmed candidate
    expect(jira.calls).toEqual([]);
    await sync([issue]); // confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["agent:working"] }]);
    for (const c of jira.calls) {
      expect(c.add).not.toContain("urgent");
      expect(c.remove).not.toContain("urgent");
      expect(c.remove).not.toContain("needs-design");
    }
  });

  test("no-change poll -> zero Jira writes", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", ["agent:working"])]);
    await sync([iss("KAN-1", "In Progress", ["agent:working"])]);
    expect(jira.calls).toEqual([]);
  });

  test("a ticket that leaves the active set (disappears from the feed) has all agent:* removed", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", [])]); // establishes tracked state: agent:working
    jira.calls.length = 0;
    await sync([]); // KAN-1 no longer active/visible
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]);
    jira.calls.length = 0;
    await sync([]); // already cleared, and no longer tracked -> nothing more happens
    expect(jira.calls).toEqual([]);
  });

  test("a ticket's human labels are never re-added when it disappears from the feed (regression)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    await sync([iss("KAN-1", "In Progress", ["needs-design", "p1"])]); // establishes agent:idle alongside human labels
    jira.calls.length = 0;
    await sync([]); // KAN-1 disappears from the feed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:idle"] }]); // never re-adds needs-design/p1
  });

  test("a ticket seen directly with a non-active status (not merely disappeared) also has agent:* cleared", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "working"]]) });
    await sync([iss("KAN-1", "In Progress", [])]);
    jira.calls.length = 0;
    await sync([iss("KAN-1", "Done", ["agent:working"])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]);
  });

  test("pr:* is independently reconciled and untouched by the active-leave cleanup", async () => {
    const jira = fakeJira();
    let pr: "open" | "approved" | "merged" | null = "approved";
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => pr,
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working", "pr:approved"], remove: [] }]);
    jira.calls.length = 0;
    await sync([]); // leaves active status
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]); // pr:approved kept
  });

  test("restart durability: an active ticket already carrying pr:merged, whose PR is confirmed merged again after a cold-cache rediscovery, gets zero label writes (no remove/re-add cycle)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      prState: async () => "merged", // fresh PrTracker after a restart, cold-cache merged-search rediscovers the same PR
    });
    await sync([iss("KAN-1", "In Progress", ["agent:working", "pr:merged"])]);
    expect(jira.calls).toEqual([]);
  });

  test("pr:* disabled (no prState dep) never adds a pr:* label, agent:* unaffected", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    await sync([iss("KAN-1", "In Progress", ["pr:open"])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["pr:open"] }]);
  });

  test("returns the set of keys written this poll", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"], ["KAN-2", "idle"]]) });
    const written = await sync([iss("KAN-1", "In Progress", []), iss("KAN-2", "In Progress", ["agent:idle"])]);
    expect([...written]).toEqual(["KAN-1"]);
  });

  test("onWrite fires once with the written keys; not at all when nothing was written", async () => {
    const jira = fakeJira();
    const onWriteCalls: string[][] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"], ["KAN-2", "idle"]]),
      onWrite: (keys) => onWriteCalls.push([...keys]),
    });
    await sync([iss("KAN-1", "In Progress", []), iss("KAN-2", "In Progress", ["agent:idle"])]);
    expect(onWriteCalls).toEqual([["KAN-1"]]);
    onWriteCalls.length = 0;
    await sync([iss("KAN-1", "In Progress", ["agent:idle"]), iss("KAN-2", "In Progress", ["agent:idle"])]); // no-op poll
    expect(onWriteCalls).toEqual([]);
  });

  test("done maps to agent:idle, not agent:working (herdr's done = sitting at its prompt)", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "done"]]) });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);
  });

  test("a persistently failing write for one issue is isolated: other issues still get written, one log line, no throw", async () => {
    const jira = fakeJiraFailingFor("KAN-BAD");
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-BAD", "idle"], ["KAN-GOOD", "idle"]]),
      log: (line) => logs.push(line),
    });
    const written = await sync([iss("KAN-BAD", "In Progress", []), iss("KAN-GOOD", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-GOOD", add: ["agent:idle"], remove: [] }]);
    expect([...written]).toEqual(["KAN-GOOD"]);
    expect(logs.some((l) => l.includes("KAN-BAD") && l.includes("write failed") && l.includes("403 forbidden"))).toBe(true);
  });

  test("a failed write is not recorded as applied: the key is retried, not treated as already-labeled", async () => {
    const failing = { on: true };
    const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
    const jira: LabelWriter = {
      async updateLabels(key, ops) {
        if (failing.on) throw new Error("timeout");
        calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
      },
    };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: () => {} });
    await sync([iss("KAN-1", "In Progress", [])]); // write fails; not recorded in lastLabels
    failing.on = false;
    await sync([iss("KAN-1", "In Progress", [])]); // retried from the same starting labels, now succeeds
    expect(calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);
  });

  test("stalled: takes precedence over idle, goes through the SAME 2-poll stabilizer as any other agent:* value", async () => {
    const jira = fakeJira();
    let stalledNow = false;
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => stalledNow, forget: () => {} },
    });
    const issue = iss("KAN-1", "In Progress", []);
    await sync([issue]); // establishes agent:idle (first observation, no flip to confirm)
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: [] }]);

    jira.calls.length = 0;
    stalledNow = true;
    const issue2 = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue2]); // 1st poll of "stalled" vs applied "idle": unconfirmed
    expect(jira.calls).toEqual([]);
    await sync([issue2]); // 2nd consecutive poll: confirmed
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:stalled"], remove: ["agent:idle"] }]);
  });

  test("stalled is never applied when the observed status isn't idle, even if the check reports true", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "working"]]),
      stalled: { check: async () => true, forget: () => {} },
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);
  });

  test("the stalled log line fires immediately (unlike the label, not delayed by the stabilizer)", async () => {
    const jira = fakeJira();
    const logs: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => true, forget: () => {} },
      log: (l) => logs.push(l),
    });
    await sync([iss("KAN-1", "In Progress", ["agent:idle"])]); // label write still suppressed (1st poll)
    expect(jira.calls).toEqual([]);
    expect(logs.some((l) => l.includes("KAN-1") && l.includes("stalled"))).toBe(true);
  });

  test("leaving the active set forgets the stalled tracker's state for that ticket", async () => {
    const jira = fakeJira();
    const forgotten: string[] = [];
    const sync = createLabelSync({
      jira,
      agentStatuses: async () => new Map([["KAN-1", "idle"]]),
      stalled: { check: async () => false, forget: (k) => forgotten.push(k) },
    });
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([]); // KAN-1 leaves the active set
    expect(forgotten).toEqual(["KAN-1"]);
  });

  test("a permanently failing write logs 'write failed' exactly once, not once per poll; a change in reason logs again", async () => {
    const jira: LabelWriter = {
      async updateLabels() { throw new Error("403 forbidden"); },
    };
    const logs: string[] = [];
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: (l) => logs.push(l) });
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([iss("KAN-1", "In Progress", [])]);
    await sync([iss("KAN-1", "In Progress", [])]);
    expect(logs.filter((l) => l.includes("KAN-1") && l.includes("write failed")).length).toBe(1);
  });

  test("a failing write on the disappearance-cleanup path is retried on a later poll instead of being dropped", async () => {
    const failing = { on: false };
    const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
    const jira: LabelWriter = {
      async updateLabels(key, ops) {
        if (failing.on) throw new Error("503 unavailable");
        calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] });
      },
    };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]), log: () => {} });
    await sync([iss("KAN-1", "In Progress", [])]); // establishes agent:idle
    calls.length = 0;
    failing.on = true;
    await sync([]); // disappears; cleanup write fails
    expect(calls).toEqual([]);
    failing.on = false;
    await sync([]); // still gone; cleanup retried, now succeeds
    expect(calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:idle"] }]);
  });
});
