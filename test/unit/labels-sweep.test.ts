import { describe, expect, test } from "bun:test";
import { sweepStaleAgentLabels } from "../../src/labels/sweep.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { LabelWriter } from "../../src/labels/sync.js";

const iss = (key: string, status: string, labels: string[]): JiraIssue =>
  ({ key, status, summary: "s", issuetype: "Task", assignee: "a", parent: null, updated: "t", labels });

function fakeJira(): LabelWriter & { calls: Array<{ key: string; add: string[]; remove: string[] }> } {
  const calls: Array<{ key: string; add: string[]; remove: string[] }> = [];
  return {
    calls,
    async updateLabels(key, ops) { calls.push({ key, add: [...(ops.add ?? [])], remove: [...(ops.remove ?? [])] }); },
  };
}

describe("sweepStaleAgentLabels", () => {
  test("clears agent:* on each hit, leaves pr:* and human labels alone", async () => {
    const jira = fakeJira();
    let seenJql = "";
    await sweepStaleAgentLabels({
      search: async (jql) => { seenJql = jql; return [iss("KAN-1", "Done", ["agent:working", "pr:merged", "needs-design"])]; },
      jira,
    });
    expect(seenJql).toContain("NOT IN");
    expect(seenJql).toContain('"In Progress"');
    expect(seenJql).toContain('"In Review"');
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:working"] }]);
  });

  test("a hit with no agent:* label produces no request", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({ search: async () => [iss("KAN-1", "To Do", ["pr:open", "urgent"])], jira });
    expect(jira.calls).toEqual([]);
  });

  test("no hits -> no requests", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({ search: async () => [], jira });
    expect(jira.calls).toEqual([]);
  });

  test("multiple hits are each swept independently", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({
      search: async () => [iss("KAN-1", "Done", ["agent:idle"]), iss("KAN-2", "To Do", ["agent:blocked", "p1"])],
      jira,
    });
    expect(jira.calls).toEqual([
      { key: "KAN-1", add: [], remove: ["agent:idle"] },
      { key: "KAN-2", add: [], remove: ["agent:blocked"] },
    ]);
  });
});
