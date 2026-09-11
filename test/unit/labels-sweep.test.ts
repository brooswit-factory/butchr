import { describe, expect, test } from "bun:test";
import { sweepStaleAgentLabels } from "../../src/labels/sweep.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { LabelWriter } from "../../src/labels/sync.js";
import { ALL_ADMISSION_LABEL_KEYS, ALL_AGENT_LABEL_KEYS } from "../../src/labels/plan.js";

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

  // BUTCHR-352: admission:* is the second namespace this sweep now covers —
  // stranded exactly the same way agent:stalled once was (BUTCHR-144) if a
  // ticket goes inactive while carrying it and the daemon is down at the
  // time. THE FALSIFIER: this test fails on a sweep that still filters only
  // isAgentLabel (the pre-BUTCHR-352 shape) — admission:withheld would then
  // survive untouched, exactly the stranding this pins against.
  test("clears admission:* alongside agent:* on the same hit (BUTCHR-352)", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({
      search: async () => [iss("KAN-1", "Done", ["agent:none", "admission:withheld", "pr:merged", "needs-design"])],
      jira,
    });
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["agent:none", "admission:withheld"] }]);
  });

  test("a hit carrying ONLY admission:* (no agent:*) is still cleared (BUTCHR-352)", async () => {
    const jira = fakeJira();
    await sweepStaleAgentLabels({ search: async () => [iss("KAN-1", "Done", ["admission:withheld"])], jira });
    expect(jira.calls).toEqual([{ key: "KAN-1", add: [], remove: ["admission:withheld"] }]);
  });
});

describe("SWEEP_JQL's labels IN (...) clause (BUTCHR-144/BUTCHR-155/BUTCHR-352)", () => {
  // THE FALSIFIER: this test's assertion alone — that the clause's quoted
  // agent:*/admission:* terms equal ALL_AGENT_LABEL_KEYS plus
  // ALL_ADMISSION_LABEL_KEYS — would still pass while BUTCHR-144's bug (or
  // its BUTCHR-352 sibling on the new namespace) is present if SWEEP_JQL
  // were quietly hand-written again to a fixed list that happens to match
  // today's values; a coincidence like that is exactly what "not a test
  // asserting today's values are listed" warns against. What actually
  // closes that gap is ALL_AGENT_LABEL_KEYS/ALL_ADMISSION_LABEL_KEYS's own
  // compile-time anchors (src/labels/plan.ts's ALL_AGENT_LABELS/
  // ALL_ADMISSION_LABELS: Record<..., true>, proven exhaustive in
  // test/unit/labels-plan.test.ts): neither AgentLabel nor AdmissionLabel
  // can grow a member without its own KEYS array growing to match. So the
  // only way this test can keep passing once either type grows is for
  // SWEEP_JQL to keep being BUILT from both arrays — a hand-written or
  // reverted clause would then omit the new member's quoted term and this
  // test goes red. That is the "someone added a label and the sweep does
  // not select it" failure mode, on either namespace.
  test("the clause's quoted agent:*/admission:* terms are exactly ALL_AGENT_LABEL_KEYS + ALL_ADMISSION_LABEL_KEYS — every member round-trips, nothing extra", async () => {
    const jira = fakeJira();
    let seenJql = "";
    await sweepStaleAgentLabels({ search: async (jql) => { seenJql = jql; return []; }, jira });
    const quoted = [...seenJql.matchAll(/"((?:agent|admission):[a-z-]+)"/g)].map((m) => m[1]);
    expect(quoted.sort()).toEqual([...ALL_AGENT_LABEL_KEYS, ...ALL_ADMISSION_LABEL_KEYS].sort());
  });
});
