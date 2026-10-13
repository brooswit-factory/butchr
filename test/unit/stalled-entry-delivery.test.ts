import { expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import { createIssueEventRules } from "../../src/resources/issue.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";
import { createLinkedEventingState } from "../../src/jira-watch/linked-eventing.js";
import { parseRules } from "../../src/rules/rules.js";

const issue = (labels: string[], updated: string): JiraIssue => ({
  key: "TASK-1", summary: "task", status: "In Progress", issuetype: "Task",
  assignee: null, parent: null, labels, updated,
});

test.each([DAEMON_WRITER, "TASK-1", "foreign-daemon"])("stalled entry bypasses %s label echo suppression for self and every related watcher, once per recipient", async (writer) => {
  const ledger = createOwnWriteLedger();
  ledger.record("TASK-1", "t1", writer, Date.now());
  const rules = createIssueEventRules({ comments: async () => [], suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()) });
  const before = issue(["agent:idle"], "t0");
  const after = issue(["agent:stalled"], "t1");
  const snapshot = (i: JiraIssue) => ({ primary: [i], related: [{ issue: i, watchers: ["BOSS-1", "BOSS-2"] }] });
  await rules.poll({ primary: [], related: [] }, snapshot(before));
  const poll = await rules.poll(snapshot(before), snapshot(after));
  for (const [watcher, space] of [["TASK-1", "primary"], ["BOSS-1", "related"], ["BOSS-2", "related"]] as const) {
    expect(await poll.decide("TASK-1", watcher, space)).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1" } } });
    expect((await poll.decide("TASK-1", watcher, space)).deliver).toBe(false);
  }
  const unchanged = await rules.poll(snapshot(after), snapshot(after));
  expect(unchanged.changedPrimary).toEqual([]);
  expect(unchanged.changedRelated).toEqual([]);
});

test("a debounced stalled entry does not swallow a concurrent real comment", async () => {
  let rows: Array<{ id: string; body: string; created: string; authorEmail: null }> = [];
  const rules = createIssueEventRules({ comments: async () => rows });
  const snapshot = (i: JiraIssue) => ({ primary: [i], related: [] });
  const idle = issue(["agent:idle"], "t0");
  const stalled = issue(["agent:stalled"], "t1");
  await rules.poll({ primary: [], related: [] }, snapshot(idle));
  const first = await rules.poll(snapshot(idle), snapshot(stalled));
  expect((await first.decide("TASK-1", "TASK-1", "primary")).deliver).toBe(true);
  const recovered = issue(["agent:idle"], "t2");
  const recovery = await rules.poll(snapshot(stalled), snapshot(recovered));
  expect((await recovery.decide("TASK-1", "TASK-1", "primary")).deliver).toBe(false);
  rows = [{ id: "c1", body: "A human asks for an update", created: new Date().toISOString(), authorEmail: null }];
  const again = await rules.poll(snapshot(recovered), snapshot(issue(["agent:stalled"], "t3")));
  expect(await again.decide("TASK-1", "TASK-1", "primary")).toEqual({ deliver: true, reason: { comment: "c1" } });
});

test.each([[], ["agent:none"], ["agent:idle"], ["agent:working"]].map(labels => ({ labels })))("stalled removal/recovery to %j stays silent for self and related watchers", async ({ labels }) => {
  const rules = createIssueEventRules({ comments: async () => [] });
  const before = issue(["agent:stalled"], "t0");
  const after = issue(labels, "t1");
  const snapshot = (i: JiraIssue) => ({ primary: [i], related: [{ issue: i, watchers: ["BOSS-1"] }] });
  await rules.poll({ primary: [], related: [] }, snapshot(before));
  const poll = await rules.poll(snapshot(before), snapshot(after));
  expect((await poll.decide("TASK-1", "TASK-1", "primary")).deliver).toBe(false);
  expect((await poll.decide("TASK-1", "BOSS-1", "related")).deliver).toBe(false);
});

test("generic linked stalled entry bypasses own-write suppression, fans out once, and keeps routine labels/cleanup silent", async () => {
  const rule = parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true }] })[0]!;
  const matches = ["OWNER-1", "OWNER-2"].map(key => ({ agentKey: `jira-work:task:${key}`, rule, issue: { ...issue([], "t0"), key, issuelinks: [{ type: "Blocks", otherEnd: "outward" as const, key: "TASK-1" }] } }));
  let target = issue(["agent:idle"], "t0");
  const sent: Array<{ agent: string; reason: unknown }> = [];
  const deps = { search: async () => [target], comments: async () => [], suppress: () => true,
    notify: async (agent: string, _about: string, reason: unknown) => { sent.push({ agent, reason }); } };
  const state = createLinkedEventingState();
  await state.runTick(matches, deps);
  target = issue(["agent:stalled"], "t1");
  await state.runTick(matches, deps);
  expect(sent.map(s => s.agent).sort()).toEqual(matches.map(m => m.agentKey).sort());
  for (const s of sent) expect(s.reason).toEqual({ linked: { events: [{ target: "TASK-1", kind: "issuelink", detail: "agent entered stalled" }] } });
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(2);
  for (const labels of [[], ["agent:working"], ["agent:idle"], ["agent:blocked"], ["admission:withheld"]]) {
    target = issue(labels, `${target.updated}x`);
    await state.runTick(matches, { ...deps, suppress: () => false });
  }
  expect(sent).toHaveLength(2);
});
