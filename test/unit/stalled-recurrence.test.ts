import { expect, test } from "bun:test";
import { StalledEvents, withStalledEvents } from "../../src/agents/stalled-events.js";
import { createResourceStallObserver } from "../../src/agents/resource-stall-observer.js";
import { createIssueEventRules } from "../../src/resources/issue.js";
import { createStalledCheck } from "../../src/agents/stalled.js";
import { createLinkedEventingState } from "../../src/jira-watch/linked-eventing.js";
import { parseRules } from "../../src/rules/rules.js";
import { parseSessionDefinition } from "../../src/resources/session-definition.js";
import { createJiraProjectResourceType } from "../../src/rules/jira-project-type.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const minute = 60_000;
const issue = (labels = ["agent:stalled"]): JiraIssue => ({ key: "TASK-1", summary: "task", status: "In Progress", issuetype: "Task", labels, updated: "unchanged", assignee: null, parent: null });

test.each([10, 40, 160, 640, 2560])("fixed %i-minute epochs repeat without backoff and reach every recipient", minutes => {
  let now = 0;
  const events = new StalledEvents(() => now);
  const observation = { key: "resource", stalled: true, minutes };
  for (let count = 1; count <= 1000; count++) {
    const notice = events.observe(observation)!;
    expect(notice.at).toBe(now);
    for (const recipient of ["self", "boss-a", "boss-b"]) {
      expect(events.pending(notice, recipient)).toBe(true);
      events.acknowledge(notice, recipient);
      expect(events.pending(events.observe(observation)!, recipient)).toBe(false);
    }
    now += minutes * minute - 1;
    expect(events.observe(observation)!.at).toBe((count - 1) * minutes * minute);
    now++;
  }
});

test("activity resets timing without changing the fixed interval", () => {
  let now = 0;
  const events = new StalledEvents(() => now);
  const observation = { key: "TASK-1", stalled: true, minutes: 10 };
  expect(events.observe(observation)!.at).toBe(0);
  now = 5 * minute;
  expect(events.observe({ ...observation, activity: now })).toBeUndefined();
  now = 10 * minute;
  expect(events.observe({ ...observation, activity: 5 * minute })).toBeUndefined();
  now = 15 * minute;
  expect(events.observe({ ...observation, activity: 5 * minute })!.at).toBe(now);
});

test("unchanged ticket uses ordinary event rules for self and all routed watchers; cleanup and duplicate polls are silent", async () => {
  let now = 0;
  let running = true;
  const events = new StalledEvents(() => now);
  const rules = withStalledEvents(createIssueEventRules({ comments: async () => [], suppress: () => true }), events,
    i => i.key, async i => ({ key: i.key, minutes: 10, stalled: running && i.labels.includes("agent:stalled") }));
  const snapshot = { primary: [issue()], related: [{ issue: issue(), watchers: ["BOSS-1", "BOSS-2"] }] };
  let poll = await rules.poll(snapshot, snapshot);
  for (const [recipient, space] of [["TASK-1", "primary"], ["BOSS-1", "related"], ["BOSS-2", "related"]] as const) {
    expect(await poll.decide("TASK-1", recipient, space)).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1", at: 0 } } });
    expect((await poll.decide("TASK-1", recipient, space)).deliver).toBe(false);
  }
  expect((await poll.decide("TASK-1", "UNRELATED", "related")).deliver).toBe(false);
  now = 10 * minute;
  poll = await rules.poll(snapshot, snapshot);
  expect((await poll.decide("TASK-1", "TASK-1", "primary"))).toMatchObject({ reason: { stalled: { at: now } } });
  running = false;
  now += 10 * minute;
  poll = await rules.poll(snapshot, snapshot);
  expect((await poll.decide("TASK-1", "BOSS-1", "related")).deliver).toBe(false);
  const cleaned = { primary: [issue([])], related: [{ issue: issue([]), watchers: ["BOSS-1"] }] };
  poll = await rules.poll(snapshot, cleaned);
  expect((await poll.decide("TASK-1", "BOSS-1", "related")).deliver).toBe(false);
  await rules.poll(cleaned, { primary: [], related: [] });
});

test("generic linked recipients receive each recurring update despite the ordinary turn cap", async () => {
  let now = 0;
  const events = new StalledEvents(() => now);
  const rule = parseRules({ rules: [{ id: "tasks", resourceProvider: "jira-work", query: "q", brief: "work", linkedEventing: true, maxLinkedTurnsPerHour: 1 }] })[0]!;
  const matches = ["BOSS-1", "BOSS-2"].map(key => ({ agentKey: `jira-work:tasks:${key}`, rule,
    issue: { ...issue([]), key, issuelinks: [{ type: "Blocks", otherEnd: "outward" as const, key: "TASK-1" }] } }));
  const sent: unknown[] = [];
  const state = createLinkedEventingState();
  const deps = { now: () => now, search: async () => [issue()], comments: async () => [], suppress: () => true,
    stalledEvents: events, stalledObservation: async () => ({ key: "TASK-1", stalled: true, minutes: 10 }),
    notify: async (_agent: string, _about: string, reason: unknown) => { sent.push(reason); } };
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(2);
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(2);
  now = 10 * minute;
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(4);
  expect(sent[2]).toMatchObject({ linked: { events: [{ stalled: true }] } });
  expect(sent[3]).toEqual(sent[2]);
});

test("comment activity reanchors inactivity rather than permanently immunizing a ticket", async () => {
  let now = 0;
  const detector = createStalledCheck({ now: () => now, minutes: 10,
    comments: async () => [{ id: "human", body: "Still waiting", created: new Date(5 * minute).toISOString() }] });
  expect(await detector.check("TASK-1", "idle")).toBe(false);
  now = 10 * minute;
  expect(await detector.check("TASK-1", "idle")).toBe(false);
  now = 15 * minute;
  expect(await detector.check("TASK-1", "idle")).toBe(true);
});

test("project/session detector resets for work, stopped agents, frozen definitions, and removal", async () => {
  let now = 0, status: string | undefined = "idle";
  const observe = createResourceStallObserver({ now: () => now, statuses: async () => new Map(status ? [["director", status]] : []), comments: async () => [] });
  expect((await observe("director", 2560)).stalled).toBe(false);
  now = 2560 * minute;
  expect((await observe("director", 2560)).stalled).toBe(true);
  status = "working";
  expect((await observe("director", 2560)).stalled).toBe(false);
  status = "idle";
  expect((await observe("director", 2560)).stalled).toBe(false);
  now += 2560 * minute;
  expect((await observe("director", 2560)).stalled).toBe(true);
  expect((await observe("director", 2560, false)).stalled).toBe(false);
  status = undefined;
  expect((await observe("director", 2560)).stalled).toBe(false);
  status = "idle";
  observe.forget("director");
  expect((await observe("director", 2560)).stalled).toBe(false);
});

test("managed-session manual timeout validates and survives parsing", () => {
  const definition = { workingDirectory: "/work", brief: "observe", vendor: "codex", tier: "tier4", permissionMode: "default", stalledMinutes: 2560 };
  expect(parseSessionDefinition(definition, "director", "/home", "linux").stalledMinutes).toBe(2560);
  for (const value of [0, -1, "2560", Infinity]) expect(() => parseSessionDefinition({ ...definition, stalledMinutes: value }, "director", "/home", "linux")).toThrow();
});

test("project provider emits recurring ordinary updates and resets on removal", async () => {
  let now = 0;
  const key = "jira-project:manager:ACME";
  const events = new StalledEvents(() => now);
  const observer = createResourceStallObserver({ now: () => now, statuses: async () => new Map([[key, "idle"]]), comments: async () => [] });
  const rule = parseRules({ rules: [{ id: "manager", resourceProvider: "jira-project", query: "{}", brief: "manage", stalledMinutes: 640 }] })[0]!;
  const type = createJiraProjectResourceType({ rules: [rule], search: async () => [{ id: "1", key: "ACME", name: "Acme" }], stalledEvents: events, resourceStallObservation: observer });
  const primary = await type.discovery.search();
  expect(primary[0]!.agentKey).toBe(key);
  const snapshot = { primary, related: [] };
  await type.eventRules.poll(snapshot, snapshot);
  now = 640 * minute;
  let poll = await type.eventRules.poll(snapshot, snapshot);
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { at: now } } });
  now *= 2;
  poll = await type.eventRules.poll(snapshot, snapshot);
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { at: now } } });
  await type.eventRules.poll(snapshot, { primary: [], related: [] });
  now += 640 * minute;
  poll = await type.eventRules.poll({ primary: [], related: [] }, snapshot);
  expect((await poll.decide(key, key, "primary")).deliver).toBe(false);
  now += 640 * minute;
  poll = await type.eventRules.poll(snapshot, snapshot);
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { at: now } } });
});

test("edited manual intervals take effect for the next update", () => {
  let now = 0;
  const events = new StalledEvents(() => now);
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 10 })!.at).toBe(0);
  now = 10 * minute;
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 40 })!.at).toBe(0);
  now = 40 * minute;
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 40 })!.at).toBe(now);
});

test("ordinary PR updates retain priority and the reminder remains due on the next poll", async () => {
  const events = new StalledEvents(() => 0);
  const rules = withStalledEvents(createIssueEventRules({ comments: async () => [] }), events,
    i => i.key, async i => ({ key: i.key, minutes: 10, stalled: true }));
  const before = { primary: [issue(["agent:stalled", "pr:open"])], related: [] };
  const after = { primary: [{ ...issue(["agent:stalled", "pr:approved"]), updated: "approved" }], related: [] };
  const poll = await rules.poll(before, after);
  expect(await poll.decide("TASK-1", "TASK-1", "primary")).toMatchObject({ deliver: true, reason: { pr: { from: "open", to: "approved" } } });
  const next = await rules.poll(after, after);
  expect(await next.decide("TASK-1", "TASK-1", "primary")).toMatchObject({ deliver: true, reason: { stalled: { key: "TASK-1" } } });
});

test("failed reminder observation does not block ordinary status updates", async () => {
  const errors: string[] = [];
  const rules = withStalledEvents(createIssueEventRules({ comments: async () => [] }), new StalledEvents(() => 0),
    i => i.key, async () => { throw new Error("unavailable"); }, undefined, id => { errors.push(id); });
  const before = { primary: [issue()], related: [] };
  const after = { primary: [{ ...issue(), status: "In Review", updated: "review" }], related: [] };
  const poll = await rules.poll(before, after);
  expect(await poll.decide("TASK-1", "TASK-1", "primary")).toMatchObject({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
  expect(errors).toEqual(["TASK-1"]);
});

test("failed linked reminder observation still delivers an ordinary linked status update", async () => {
  const rule = parseRules({ rules: [{ id: "tasks", resourceProvider: "jira-work", query: "q", brief: "work", linkedEventing: true }] })[0]!;
  const matches = [{ agentKey: "jira-work:tasks:BOSS-1", rule,
    issue: { ...issue([]), key: "BOSS-1", issuelinks: [{ type: "Blocks", otherEnd: "outward" as const, key: "TASK-1" }] } }];
  let target = issue();
  const sent: unknown[] = [];
  const state = createLinkedEventingState();
  const deps = { search: async () => [target], comments: async () => [], stalledEvents: new StalledEvents(() => 0),
    stalledObservation: async (): Promise<never> => { throw new Error("unavailable"); },
    notify: async (_agent: string, _about: string, reason: unknown) => { sent.push(reason); } };
  await state.runTick(matches, deps);
  target = { ...target, status: "In Review", updated: "review" };
  await state.runTick(matches, deps);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ linked: { events: [{ detail: 'status changed from "In Progress" to "In Review"' }] } });
});
