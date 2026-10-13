import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test.each([10, 40, 160, 640, 2560])("fixed %i-minute epochs repeat without backoff and share counts across recipients", minutes => {
  let now = 0;
  const events = new StalledEvents(() => now);
  const observation = { key: "resource", stalled: true, minutes };
  for (let count = 1; count <= 1000; count++) {
    const notice = events.observe(observation)!;
    expect(notice.count).toBe(count);
    for (const recipient of ["self", "boss-a", "boss-b"]) {
      expect(events.pending(notice, recipient)).toBe(true);
      events.acknowledge(notice, recipient);
      expect(events.pending(events.observe(observation)!, recipient)).toBe(false);
    }
    now += minutes * minute - 1;
    expect(events.observe(observation)!.count).toBe(count);
    now++;
  }
});

test("activity resets timing; counts survive episodes and disk reload; downtime does not burst", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-stall-"));
  try {
    let now = 0;
    const path = join(root, "counts.json");
    let events = new StalledEvents(() => now, path);
    const observation = { key: "jira:TASK-1", stalled: true, minutes: 10 };
    expect(events.observe(observation)!.count).toBe(1);
    now = 5 * minute;
    expect(events.observe({ ...observation, activity: now })).toBeUndefined();
    now = 10 * minute;
    expect(events.observe({ ...observation, activity: 5 * minute })).toBeUndefined();
    now = 15 * minute;
    expect(events.observe({ ...observation, activity: 5 * minute })!.count).toBe(2);
    events.observe({ ...observation, stalled: false });
    now = 25 * minute;
    expect(events.observe(observation)!.count).toBe(3);
    events = new StalledEvents(() => now, path);
    expect(events.count(observation.key)).toBe(3);
    expect(events.observe(observation)).toBeUndefined();
    now += 10000 * minute;
    expect(events.observe(observation)!.count).toBe(4);
    expect(events.observe(observation)!.count).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    expect(await poll.decide("TASK-1", recipient, space)).toEqual({ deliver: true, reason: { stalled: { key: "TASK-1", count: 1, at: 0 } } });
    expect((await poll.decide("TASK-1", recipient, space)).deliver).toBe(false);
  }
  expect((await poll.decide("TASK-1", "UNRELATED", "related")).deliver).toBe(false);
  now = 10 * minute;
  poll = await rules.poll(snapshot, snapshot);
  expect((await poll.decide("TASK-1", "TASK-1", "primary"))).toMatchObject({ reason: { stalled: { count: 2 } } });
  running = false;
  now += 10 * minute;
  poll = await rules.poll(snapshot, snapshot);
  expect((await poll.decide("TASK-1", "BOSS-1", "related")).deliver).toBe(false);
  const cleaned = { primary: [issue([])], related: [{ issue: issue([]), watchers: ["BOSS-1"] }] };
  poll = await rules.poll(snapshot, cleaned);
  expect((await poll.decide("TASK-1", "BOSS-1", "related")).deliver).toBe(false);
  await rules.poll(cleaned, { primary: [], related: [] });
  expect(events.count("TASK-1")).toBe(2);
});

test("generic linked recipients receive the same recurring count despite the ordinary turn cap", async () => {
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
  expect(sent[2]).toMatchObject({ linked: { events: [{ stalledCount: 2 }] } });
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

test("project provider emits recurring ordinary updates, resets on removal, and preserves the count", async () => {
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
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { count: 1 } } });
  now *= 2;
  poll = await type.eventRules.poll(snapshot, snapshot);
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { count: 2 } } });
  await type.eventRules.poll(snapshot, { primary: [], related: [] });
  now += 640 * minute;
  poll = await type.eventRules.poll({ primary: [], related: [] }, snapshot);
  expect((await poll.decide(key, key, "primary")).deliver).toBe(false);
  now += 640 * minute;
  poll = await type.eventRules.poll(snapshot, snapshot);
  expect(await poll.decide(key, key, "primary")).toMatchObject({ deliver: true, reason: { stalled: { count: 3 } } });
});

test("edited manual intervals take effect without changing the cumulative count", () => {
  let now = 0;
  const events = new StalledEvents(() => now);
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 10 })!.count).toBe(1);
  now = 10 * minute;
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 40 })!.count).toBe(1);
  now = 40 * minute;
  expect(events.observe({ key: "TASK-1", stalled: true, minutes: 40 })!.count).toBe(2);
});
