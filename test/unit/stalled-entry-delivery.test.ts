import { expect, test } from "bun:test";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";
import { createIssueEventRules } from "../../src/resources/issue.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../../src/jira-watch/own-writes.js";
import { createLinkedEventingState } from "../../src/jira-watch/linked-eventing.js";
import { parseRules } from "../../src/rules/rules.js";

const issue = (labels: string[], updated: string): JiraIssue => ({key: "TASK-1", summary: "task", status: "In Progress", issuetype: "Task", assignee: null, parent: null, labels, updated});
const snapshot = (i: JiraIssue) => ({primary: [i], related: [{issue: i, watchers: ["BOSS-1", "BOSS-2"]}]});

test.each([DAEMON_WRITER, "TASK-1", "foreign-daemon"])("stalled labels from %s stay silent; the later visible notice delivers to self and every watcher", async writer => {
  let rows: JiraComment[] = [];
  const ledger = createOwnWriteLedger();
  ledger.record("TASK-1", "t1", writer, Date.now());
  const rules = createIssueEventRules({comments: async () => rows, suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now())});
  const idle = issue(["agent:idle"], "t0"), stalled = issue(["agent:stalled"], "t1");
  await rules.poll({primary: [], related: []}, snapshot(idle));
  const entry = await rules.poll(snapshot(idle), snapshot(stalled));
  for (const [watcher, space] of [["TASK-1", "primary"], ["BOSS-1", "related"], ["BOSS-2", "related"]] as const) expect((await entry.decide("TASK-1", watcher, space)).deliver).toBe(false);
  rows = [{id: "c1", body: "[butchr:stall] A visible stall notice", created: new Date().toISOString(), authorEmail: null}];
  const commented = issue(["agent:stalled"], "t2");
  const notice = await rules.poll(snapshot(stalled), snapshot(commented));
  for (const [watcher, space] of [["TASK-1", "primary"], ["BOSS-1", "related"], ["BOSS-2", "related"]] as const) expect(await notice.decide("TASK-1", watcher, space)).toEqual({deliver: true, reason: {comment: "c1"}});
  const unchanged = await rules.poll(snapshot(commented), snapshot(commented));
  expect(unchanged.changedPrimary).toEqual([]);
  expect(unchanged.changedRelated).toEqual([]);
});

test("generic linked watchers receive the ordinary notice once, with no label-only event", async () => {
  const rule = parseRules({rules: [{id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true}]})[0]!;
  const matches = ["OWNER-1", "OWNER-2"].map(key => ({agentKey: `jira-work:task:${key}`, rule, issue: {...issue([], "t0"), key, issuelinks: [{type: "Blocks", otherEnd: "outward" as const, key: "TASK-1"}]}}));
  let target = issue(["agent:idle"], "t0");
  let rows: JiraComment[] = [];
  const sent: string[] = [];
  const deps = {search: async () => [target], comments: async () => rows, notify: async (agent: string) => {sent.push(agent);}};
  const state = createLinkedEventingState();
  await state.runTick(matches, deps);
  target = issue(["agent:stalled"], "t1");
  await state.runTick(matches, deps);
  expect(sent).toEqual([]);
  rows = [{id: "c1", body: "[butchr:stall] Visible notice", created: new Date().toISOString(), authorEmail: null}];
  target = issue(["agent:stalled"], "t2");
  await state.runTick(matches, deps);
  expect(sent.sort()).toEqual(matches.map(m => m.agentKey).sort());
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(2);
});
