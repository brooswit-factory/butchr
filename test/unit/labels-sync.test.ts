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
});
