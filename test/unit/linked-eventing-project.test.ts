import { describe, expect, test } from "bun:test";
import type { JiraComment, JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";
import { addLink, removeLink, type LinkStore } from "../../src/resources/link-store.js";
import { parseResourceRef, type ResourceRef } from "../../src/resources/resource-ref.js";

/**
 * BUTCHR-469: linked-eventing for `jira-project` owners — one member-
 * discovery watch (`project = <key> AND updated >= "-<N>m"`, a per-project
 * watermark) plus this project's own managed links
 * (`brooswit.butchr.links`, reused via FACTORY-9's `managedLinkedItems`),
 * both delivered through the EXACT SAME coalescer/rate-cap/notify
 * `test/unit/linked-eventing.test.ts` and
 * `test/unit/linked-eventing-managed-links.test.ts` already cover for an
 * issue owner — that machinery is reused UNCHANGED here, never re-tested.
 * This file covers what is NEW for a project owner specifically: the
 * watermark's own no-flood/delayed-not-lost contract, member/managed-link
 * dedup, and why a member aging out of the watermark window must never read
 * as a removal.
 */

const ref = (s: string): ResourceRef => parseResourceRef(s);

function fakeLinkStore(initial: Record<string, string[]> = {}): LinkStore {
  const data: Record<string, string[]> = structuredClone(initial);
  return {
    async list(ownerKey) { return data[ownerKey] ?? []; },
    async add(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (existing.includes(targetKey)) return false;
      data[ownerKey] = [...existing, targetKey];
      return true;
    },
    async remove(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (!existing.includes(targetKey)) return false;
      data[ownerKey] = existing.filter((t) => t !== targetKey);
      return true;
    },
  };
}

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const projectMatch = (agentKey: string, r: Rule, projectKey: string): ProjectLinkedEventingMatch => ({ agentKey, rule: r, projectKey });
const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;

const PROJECT_JQL_RE = /^project = (\S+) AND updated >= "-(\d+)m"$/;
const KEY_IN_RE = /^key in \((.*)\)$/;

function fakeProjectDeps(world: Record<string, JiraIssue>, membersByProject: Record<string, string[]>, opts: {
  linkStore?: LinkStore;
  commentsByKey?: Record<string, JiraComment[]>;
  now?: { value: number };
  failProjectSearchFor?: Set<string>;
} = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const logs: string[] = [];
  const searchCalls: string[] = [];
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      searchCalls.push(jql);
      const keyIn = KEY_IN_RE.exec(jql);
      if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      const proj = PROJECT_JQL_RE.exec(jql);
      if (proj) {
        const projectKey = proj[1]!;
        if (opts.failProjectSearchFor?.has(projectKey)) throw new Error(`member search offline for ${projectKey}`);
        return (membersByProject[projectKey] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      }
      throw new Error(`fakeProjectDeps: unexpected JQL ${JSON.stringify(jql)}`);
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(opts.linkStore ? { linkStore: opts.linkStore } : {}),
    ...(opts.commentsByKey ? { comments: async (key: string) => opts.commentsByKey![key] ?? [] } : {}),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
  };
  return { deps, notified, logs, searchCalls };
}

describe("BUTCHR-469: jira-project member-discovery watch", () => {
  test("a rule without linkedEventing yields zero member searches and zero link-store reads", async () => {
    const state = createLinkedEventingState();
    const throwingStore: LinkStore = { list: async () => { throw new Error("must not be called"); }, add: async () => true, remove: async () => true };
    const { deps, notified, searchCalls } = fakeProjectDeps({}, { BUTCHR: ["BUTCHR-1"] }, { linkStore: throwingStore });
    const r = rule({ linkedEventing: undefined });
    await state.runTick([], deps, [projectMatch("jira-project:mgrs:BUTCHR", r, "BUTCHR")]);
    expect(searchCalls).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  test("first sighting seeds the watermark and issues NO member search at all — no historical flood on first tick or daemon restart", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const { deps, notified, searchCalls } = fakeProjectDeps(world, { BUTCHR: ["BUTCHR-1"] });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");
    await state.runTick([], deps, [m]);
    expect(searchCalls).toHaveLength(0); // not even the shared batched fetch — nothing was discovered to fetch
    expect(notified).toHaveLength(0);
  });

  test("opt-in yields one watch per project: from the second tick on, the member search runs, a first-sighting member seeds silently, and a later real change delivers exactly one event", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const { deps, notified, searchCalls } = fakeProjectDeps(world, { BUTCHR: ["BUTCHR-1"] });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // member search runs now; first sighting of BUTCHR-1 seeds silently
    expect(searchCalls.some((q) => PROJECT_JQL_RE.test(q))).toBe(true);
    expect(notified).toHaveLength(0);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" });
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]);
  });

  test("two projects have independent watermarks and independent notify streams", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "AAA-1": issue("AAA-1"), "BBB-1": issue("BBB-1") };
    const membersByProject = { AAA: ["AAA-1"], BBB: ["BBB-1"] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const mA = projectMatch("jira-project:mgrs:AAA", rule(), "AAA");
    const mB = projectMatch("jira-project:mgrs:BBB", rule(), "BBB");

    await state.runTick([], deps, [mA, mB]); // both seed
    await state.runTick([], deps, [mA, mB]); // both search, both seed silently
    expect(notified).toHaveLength(0);

    world["AAA-1"] = issue("AAA-1", { status: "Done" });
    await state.runTick([], deps, [mA, mB]);
    expect(notified.map((n) => n.agent)).toEqual(["jira-project:mgrs:AAA"]); // BBB unaffected by AAA's own change
  });

  test("a member that ages out of the watermark window is NOT reported as removed — it is still a project member, just not recently touched", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: ["BUTCHR-1"] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // BUTCHR-1 seen, seeded silently
    membersByProject.BUTCHR = []; // BUTCHR-1 no longer recently touched — simulates aging out of the JQL window
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(0); // must NOT read as "no longer linked"
  });

  test("a managed link on a project owner IS removal-tracked: 'no longer linked' fires once on genuine removal", async () => {
    const state = createLinkedEventingState();
    const store = fakeLinkStore();
    const ownerRef = ref("jira-project:BUTCHR");
    const targetRef = ref("jira-work-item:BUTCHR-2");
    await addLink(store, ownerRef, targetRef);
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const { deps, notified } = fakeProjectDeps(world, {}, { linkStore: store });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark (no members) + seed managed-link baseline
    await state.runTick([], deps, [m]); // no-op tick
    expect(notified).toHaveLength(0);

    await removeLink(store, ownerRef, targetRef);
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: "no longer linked" }]);
  });

  test("an issue that is both a project member AND a managed-link target yields ONE event line, never two", async () => {
    const state = createLinkedEventingState();
    const store = fakeLinkStore();
    await addLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-9"));
    const world: Record<string, JiraIssue> = { "BUTCHR-9": issue("BUTCHR-9", { status: "To Do" }) };
    const membersByProject = { BUTCHR: ["BUTCHR-9"] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject, { linkStore: store });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark + managed-link baseline
    await state.runTick([], deps, [m]); // member search runs; BUTCHR-9 already baselined via the managed link — no duplicate seeding event either
    expect(notified).toHaveLength(0);

    world["BUTCHR-9"] = issue("BUTCHR-9", { status: "In Progress" });
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-9", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]); // ONE line, not two
  });

  test("coalescing: many members changing in one tick produce ONE nudge for the project owner", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = {
      "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }),
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }),
      "BUTCHR-3": issue("BUTCHR-3", { status: "To Do" }),
    };
    const membersByProject = { BUTCHR: ["BUTCHR-1", "BUTCHR-2", "BUTCHR-3"] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // all three seed silently
    expect(notified).toHaveLength(0);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" });
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Review" });
    world["BUTCHR-3"] = issue("BUTCHR-3", { status: "Done" });
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason).map((e) => e.target).sort()).toEqual(["BUTCHR-1", "BUTCHR-2", "BUTCHR-3"]);
  });

  test("rate cap: a capped project-owner tick is retried (delayed, not lost) on the next allowed tick", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject = { BUTCHR: ["BUTCHR-1"] };
    const now = { value: 0 };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { now });
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const m = projectMatch("jira-project:mgrs:BUTCHR", r, "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // seed BUTCHR-1 baseline
    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" });
    await state.runTick([], deps, [m]); // uses the one allowed turn
    expect(notified).toHaveLength(1);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" });
    await state.runTick([], deps, [m]); // capped — dropped this tick, not lost
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes("BUTCHR"))).toBe(true);

    now.value += 61 * 60_000;
    await state.runTick([], deps, [m]); // the same outstanding change is re-detected and delivered
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: 'status changed from "In Progress" to "Done"' }]);
  });

  test("a failed member search fails open: logged, skips member discovery for that owner only, watermark not advanced, managed links and other owners unaffected", async () => {
    const state = createLinkedEventingState();
    const store = fakeLinkStore();
    await addLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1"), "BUTCHR-2": issue("BUTCHR-2"), "OTHER-1": issue("OTHER-1") };
    const membersByProject = { BUTCHR: ["BUTCHR-1"], OTHER: ["OTHER-1"] };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { linkStore: store, failProjectSearchFor: new Set(["BUTCHR"]) });
    const bad = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");
    const good = projectMatch("jira-project:mgrs:OTHER", rule({ id: "other" }), "OTHER");

    await state.runTick([], deps, [bad, good]); // seed both watermarks
    await state.runTick([], deps, [bad, good]); // BUTCHR's member search fails; OTHER's succeeds; BUTCHR's managed link still seeds
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] project-member search failed") && l.includes("BUTCHR"))).toBe(true);
    expect(notified).toHaveLength(0); // pure seeding tick either way

    // BUTCHR's managed link still genuinely tracked despite the member-search failure:
    await removeLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-2"));
    await state.runTick([], deps, [bad, good]);
    expect(notified.map((n) => n.agent)).toEqual(["jira-project:mgrs:BUTCHR"]);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: "no longer linked" }]);
  });

  test("a broken link store fails open for its own project owner without blocking that SAME owner's member discovery or any other owner's tick", async () => {
    const badStore: LinkStore = {
      list: async (ownerKey) => { if (ownerKey === "jira-project:BUTCHR") throw new Error("disk error"); return []; },
      add: async () => true,
      remove: async () => true,
    };
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject = { BUTCHR: ["BUTCHR-1"] };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { linkStore: badStore });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // link-store fails (logged), member discovery still runs and seeds BUTCHR-1
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] managed-link fetch failed") && l.includes("BUTCHR"))).toBe(true);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" });
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1); // member discovery kept working despite the broken link store
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]);
  });

  test("comment events: a new comment on a project member is reported as 'got a new comment', the same mechanism an issue owner's linked target already uses", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { updated: "t1" }) };
    const membersByProject = { BUTCHR: ["BUTCHR-1"] };
    const commentsByKey = { "BUTCHR-1": [{ id: "c1", body: "first", created: "t1", authorEmail: null }] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject, { commentsByKey });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // seeds BUTCHR-1's snapshot, including commentCursor "c1"
    expect(notified).toHaveLength(0);

    world["BUTCHR-1"] = issue("BUTCHR-1", { updated: "t2" });
    commentsByKey["BUTCHR-1"] = [{ id: "c2", body: "second", created: "t2", authorEmail: null }, { id: "c1", body: "first", created: "t1", authorEmail: null }];
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: "got a new comment" }]);
  });

  test("maxLinkedItems caps the combined member+managed-link set uniformly", async () => {
    const state = createLinkedEventingState();
    const store = fakeLinkStore();
    await addLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-9"));
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1"), "BUTCHR-9": issue("BUTCHR-9") };
    const membersByProject = { BUTCHR: ["BUTCHR-1"] };
    const { deps, searchCalls } = fakeProjectDeps(world, membersByProject, { linkStore: store });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule({ maxLinkedItems: 1 }), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]);
    // Only ONE of the two candidate targets is ever fetched in the shared batch — the cap bit.
    const batched = searchCalls.filter((q) => KEY_IN_RE.test(q));
    expect(batched.length).toBeGreaterThan(0);
    for (const q of batched) expect(q.split(",").length).toBeLessThanOrEqual(1);
  });
});
