import { describe, expect, test } from "bun:test";
import { sweepAbsentLiveAgentLabels, sweepStaleAgentLabels } from "../../src/labels/sweep.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { LabelWriter } from "../../src/labels/sync.js";
import { ALL_AGENT_LABEL_KEYS } from "../../src/labels/plan.js";

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

  test("historical admission labels are outside the startup sweep's ownership", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({
      search: async () => [iss("KAN-1", "Done", ["agent:none", "admission:withheld", "pr:merged", "needs-design"])],
      jira,
    });
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:none"] }]);
  });

  test("a hit carrying only a historical admission label produces no request", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({ search: async () => [iss("KAN-1", "Done", ["admission:withheld"])], jira });
    expect(jira.calls).toEqual([]);
  });
});

describe("sweepAbsentLiveAgentLabels (FACTORY-1001)", () => {
  test("table-driven lifecycle matrix purges only absent panes owned by this daemon", async () => {
    const cases = [
      { name: "stop/drain", live: [], owned: ["FACTORY-10"], labels: ["agent:working"], expected: ["agent:working"] },
      { name: "restart", live: [], owned: ["FACTORY-11"], labels: ["agent:stalled", "pr:open"], expected: ["agent:stalled"] },
      { name: "pane gone", live: [], owned: ["FACTORY-12"], labels: ["agent:blocked"], expected: ["agent:blocked"] },
      { name: "live pane", live: ["FACTORY-13"], owned: ["FACTORY-13"], labels: ["agent:idle"], expected: [] },
      { name: "other daemon ownership", live: [], owned: [], labels: ["agent:working"], expected: [], found: false },
      { name: "no-wake/no label", live: [], owned: ["FACTORY-15"], labels: ["pr:open"], expected: [] },
    ];
    for (const scenario of cases) {
      const jira = fakeJira();
      const writes: string[][] = [];
      await sweepAbsentLiveAgentLabels({
        search: async () => scenario.found === false ? [] : [iss(`FACTORY-${10 + cases.indexOf(scenario)}`, "In Progress", scenario.labels)],
        jira,
        liveKeys: new Set(scenario.live),
        ownedKeys: new Set(scenario.owned),
        onWrite: (keys) => writes.push([...keys]),
      });
      expect(jira.calls.map((call) => call.remove), scenario.name).toEqual(scenario.expected.length ? [scenario.expected] : []);
      expect(writes, scenario.name).toEqual(scenario.expected.length ? [[`FACTORY-${10 + cases.indexOf(scenario)}`]] : []);
    }
  });

  test("purges a labelled active ticket outside the rule query when its owned pane is gone, without a notification seam", async () => {
    const jira = fakeJira();
    const writes: string[][] = [];
    await sweepAbsentLiveAgentLabels({
      search: async () => [iss("MINECRAFT-168", "In Progress", ["agent:working", "needs-design"])],
      jira,
      liveKeys: new Set(),
      ownedKeys: new Set(["MINECRAFT-168"]),
      onWrite: (keys) => writes.push([...keys]),
    });
    expect(jira.calls).toEqual([{ key: "MINECRAFT-168", add: [], remove: ["agent:working"] }]);
    expect(writes).toEqual([["MINECRAFT-168"]]);
  });

  test("does not purge another daemon's live pane or a genuinely live owned pane", async () => {
    const jira = fakeJira();
    await sweepAbsentLiveAgentLabels({
      search: async () => [iss("FACTORY-7", "In Progress", ["agent:idle"]), iss("FACTORY-8", "In Progress", ["agent:blocked"])],
      jira,
      liveKeys: new Set(["FACTORY-7", "FACTORY-8"]),
      ownedKeys: new Set(["FACTORY-7"]),
    });
    expect(jira.calls).toEqual([]);
  });

  test("selects every non-none agent state from the canonical anchor", async () => {
    const jira = fakeJira();
    let jql = "";
    await sweepAbsentLiveAgentLabels({ search: async (value) => { jql = value; return []; }, jira, liveKeys: new Set(), ownedKeys: new Set(["FACTORY-9"]) });
    const quoted = [...jql.matchAll(/"(agent:[a-z-]+)"/g)].map((m) => m[1]);
    expect(quoted.sort()).toEqual(ALL_AGENT_LABEL_KEYS.filter((label) => label !== "agent:none").sort());
    expect(jql).toContain("key IN (FACTORY-9)");
  });
});

describe("SWEEP_JQL's labels IN (...) clause (BUTCHR-144/BUTCHR-155)", () => {
  // ALL_AGENT_LABEL_KEYS's exhaustive Record grows when AgentLabel grows;
  // deriving this selection from it keeps newly added states in the sweep.
  test("the clause selects exactly ALL_AGENT_LABEL_KEYS and no retired namespace", async () => {
    const jira = fakeJira();
    let seenJql = "";
    await sweepStaleAgentLabels({ search: async (jql) => { seenJql = jql; return []; }, jira });
    const clause = seenJql.match(/labels IN \(([^)]+)\)/)?.[1] ?? "";
    const quoted = [...clause.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]);
    expect(quoted.sort()).toEqual([...ALL_AGENT_LABEL_KEYS].sort());
    expect(seenJql).not.toContain("admission:");
  });
});
