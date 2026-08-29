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
  test("working -> idle -> blocked -> none: exactly one Jira update per issue per poll", async () => {
    const jira = fakeJira();
    const agentStatus = { current: "working" as string | null };
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map(agentStatus.current ? [["KAN-1", agentStatus.current]] : []) });

    let issue = iss("KAN-1", "In Progress", []);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:working"], remove: [] }]);

    jira.calls.length = 0;
    agentStatus.current = "idle";
    issue = iss("KAN-1", "In Progress", ["agent:working"]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:idle"], remove: ["agent:working"] }]);

    jira.calls.length = 0;
    agentStatus.current = "blocked";
    issue = iss("KAN-1", "In Progress", ["agent:idle"]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:blocked"], remove: ["agent:idle"] }]);

    jira.calls.length = 0;
    agentStatus.current = null;
    issue = iss("KAN-1", "In Progress", ["agent:blocked"]);
    await sync([issue]);
    expect(jira.calls).toEqual([{ key: "KAN-1", add: ["agent:none"], remove: ["agent:blocked"] }]);
  });

  test("human labels are never added or removed, and survive reconciliation", async () => {
    const jira = fakeJira();
    const sync = createLabelSync({ jira, agentStatuses: async () => new Map([["KAN-1", "idle"]]) });
    await sync([iss("KAN-1", "In Progress", ["agent:working", "urgent", "needs-design"])]);
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
