import { describe, expect, test } from "bun:test";
import type { JiraComment, JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";
import { addLink, removeLink, type LinkStore } from "../../src/resources/link-store.js";
import { parseResourceRef, type ResourceRef } from "../../src/resources/resource-ref.js";

/**
 * BUTCHR-469: linked-eventing for `jira-project` owners — one member-
 * discovery watch (`project = <key> AND updated >= "-<N>m" ORDER BY updated
 * ASC`, a per-project watermark) plus this project's own managed links
 * (`brooswit.butchr.links`, reused via FACTORY-9's `managedLinkedItems`),
 * both delivered through the EXACT SAME coalescer/rate-cap/notify
 * `test/unit/linked-eventing.test.ts` and
 * `test/unit/linked-eventing-managed-links.test.ts` already cover for an
 * issue owner — that machinery is reused UNCHANGED here, never re-tested.
 * This file covers what is NEW for a project owner specifically.
 *
 * `membersByProject` in `fakeProjectDeps` models REAL Jira window-search
 * semantics: a key is listed for a project on exactly the tick(s) Jira
 * would actually return it — i.e., the tick(s) its `updated` genuinely
 * falls at or after the then-current watermark. A member is NEVER returned
 * on a tick where it did not change (review round 1 finding: an earlier
 * draft of these tests had the fake return the SAME unchanged member on
 * every tick, which hid a real bug — see "the first real change to a
 * project member" tests below for the fixed behaviour and its regression
 * coverage).
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

const PROJECT_JQL_RE = /^project = (\S+) AND updated >= "-(\d+)m" ORDER BY updated ASC$/;
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
    const { deps, notified, searchCalls } = fakeProjectDeps(world, {}); // BUTCHR-1 did NOT just change — not in the window on any tick yet
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");
    await state.runTick([], deps, [m]);
    expect(searchCalls).toHaveLength(0); // not even the shared batched fetch — nothing was discovered to fetch
    expect(notified).toHaveLength(0);
  });

  describe("review round 1 regression: a member's first real change must be reported, never swallowed as a silent baseline", () => {
    test("reviewer's own repro: tick 1 seeds the watermark, tick 2's window is empty (nothing touched yet), tick 3's window returns the member that just changed — exactly one notification, not zero", async () => {
      const state = createLinkedEventingState();
      const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
      const membersByProject: Record<string, string[]> = { BUTCHR: [] };
      const { deps, notified } = fakeProjectDeps(world, membersByProject);
      const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

      await state.runTick([], deps, [m]); // tick 1: seeds the owner's watermark, searches nothing
      await state.runTick([], deps, [m]); // tick 2: window search runs, returns nothing — BUTCHR-1 not yet touched
      expect(notified).toHaveLength(0);

      world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" }); // the real change
      membersByProject.BUTCHR = ["BUTCHR-1"]; // ...which is exactly why Jira's own window search would now return it
      await state.runTick([], deps, [m]); // tick 3
      expect(notified).toHaveLength(1); // NOT zero — this is the bug review round 1 found
      expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: expect.stringMatching(/^updated since /) }]);
    });

    test("a member's SECOND appearance, once it already has a baseline, diffs normally (a real status-change detail, not the generic first-appearance phrasing)", async () => {
      const state = createLinkedEventingState();
      const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
      const membersByProject: Record<string, string[]> = { BUTCHR: [] };
      const { deps, notified } = fakeProjectDeps(world, membersByProject);
      const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

      await state.runTick([], deps, [m]); // seed watermark
      membersByProject.BUTCHR = ["BUTCHR-1"];
      await state.runTick([], deps, [m]); // first appearance — reported, baseline now set to status "To Do"
      expect(notified).toHaveLength(1);

      membersByProject.BUTCHR = []; // ages out of the window — no further change yet
      await state.runTick([], deps, [m]);
      expect(notified).toHaveLength(1); // unchanged

      world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress" });
      membersByProject.BUTCHR = ["BUTCHR-1"]; // changed again — back in the window
      await state.runTick([], deps, [m]);
      expect(notified).toHaveLength(2);
      expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]); // a real diff, not the generic first-appearance phrasing
    });

    test("survives a daemon restart: a fresh state (no baselines, no watermark) still reports the member's next real change instead of re-swallowing it", async () => {
      const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
      const membersByProject: Record<string, string[]> = { BUTCHR: [] };
      const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

      // Before the "restart": some prior state existed and even reported once — irrelevant to what follows, included only to make clear this is a genuine restart, not a first-ever run.
      const before = createLinkedEventingState();
      const { deps: depsBefore } = fakeProjectDeps(world, membersByProject);
      await before.runTick([], depsBefore, [m]);
      membersByProject.BUTCHR = ["BUTCHR-1"];
      await before.runTick([], depsBefore, [m]);

      // Restart: brand-new state, in-memory maps empty — the exact shape a real daemon restart produces.
      const after = createLinkedEventingState();
      const { deps: depsAfter, notified: notifiedAfter } = fakeProjectDeps(world, membersByProject);
      await after.runTick([], depsAfter, [m]); // first sighting under the NEW state: seeds a fresh watermark, searches nothing
      expect(notifiedAfter).toHaveLength(0);

      world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" }); // a genuine post-restart change
      membersByProject.BUTCHR = ["BUTCHR-1"];
      await after.runTick([], depsAfter, [m]);
      expect(notifiedAfter).toHaveLength(1); // reported — NOT lost because the restart wiped the old baseline
    });
  });

  test("opt-in yields one watch per project", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, searchCalls } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed
    await state.runTick([], deps, [m]);
    const projectSearches = searchCalls.filter((q) => PROJECT_JQL_RE.test(q));
    expect(projectSearches).toHaveLength(1); // exactly one member-discovery search this tick, for this one project
    expect(projectSearches[0]).toMatch(/^project = BUTCHR AND updated >= "-\d+m" ORDER BY updated ASC$/);
  });

  test("two projects have independent watermarks and independent notify streams", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "AAA-1": issue("AAA-1"), "BBB-1": issue("BBB-1") };
    const membersByProject: Record<string, string[]> = { AAA: [], BBB: [] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const mA = projectMatch("jira-project:mgrs:AAA", rule(), "AAA");
    const mB = projectMatch("jira-project:mgrs:BBB", rule(), "BBB");

    await state.runTick([], deps, [mA, mB]); // both seed
    await state.runTick([], deps, [mA, mB]); // both search, both windows empty
    expect(notified).toHaveLength(0);

    membersByProject.AAA = ["AAA-1"]; // only AAA's project changed
    await state.runTick([], deps, [mA, mB]);
    expect(notified.map((n) => n.agent)).toEqual(["jira-project:mgrs:AAA"]); // BBB unaffected by AAA's own change
  });

  test("a member that ages out of the watermark window without ever having a baseline is silently forgotten — NOT reported as removed, and NOT reported at all (it never appeared as a change to begin with)", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    await state.runTick([], deps, [m]); // empty window
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // appears, reported once, baseline seeded to its current snapshot
    expect(notified).toHaveLength(1);

    membersByProject.BUTCHR = []; // ages out — still a project member, just not recently touched
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1); // must NOT read as "no longer linked" (there is no removal event kind for a member at all)
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
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject, { linkStore: store });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark + managed-link baseline (silent — managed links always seed silently)
    expect(notified).toHaveLength(0);

    world["BUTCHR-9"] = issue("BUTCHR-9", { status: "In Progress" }); // the real change that also makes it a member this tick
    membersByProject.BUTCHR = ["BUTCHR-9"];
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-9", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]); // ONE line, a real diff (baseline already existed from the managed-link seed) — never two, never the generic first-appearance phrasing
  });

  test("coalescing: many members changing in one tick produce ONE nudge for the project owner", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = {
      "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }),
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }),
      "BUTCHR-3": issue("BUTCHR-3", { status: "To Do" }),
    };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark

    membersByProject.BUTCHR = ["BUTCHR-1", "BUTCHR-2", "BUTCHR-3"]; // all three just changed, in the SAME tick's window
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(1); // one nudge, not three
    expect(linkedEvents(notified[0]!.reason).map((e) => e.target).sort()).toEqual(["BUTCHR-1", "BUTCHR-2", "BUTCHR-3"]);
  });

  test("rate cap: a capped project-owner tick is retried (delayed, not lost) on the next allowed tick", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { now });
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const m = projectMatch("jira-project:mgrs:BUTCHR", r, "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // first appearance — uses the one allowed turn
    expect(notified).toHaveLength(1);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" }); // BUTCHR-1 already has a baseline now, so this is a normal diff
    await state.runTick([], deps, [m]); // capped — dropped this tick, not lost; watermark held (advance() never runs on a capped tick)
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes("BUTCHR"))).toBe(true);

    now.value += 61 * 60_000;
    await state.runTick([], deps, [m]); // the same outstanding change is re-detected (BUTCHR-1 still in the held window) and delivered
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: 'status changed from "To Do" to "Done"' }]);
  });

  test("review round 1 regression: a member dropped by maxLinkedItems holds this owner's ENTIRE watermark — the capped member is retried, not lost, once room exists", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = {
      "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }),
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }),
    };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject);
    const capped = projectMatch("jira-project:mgrs:BUTCHR", rule({ maxLinkedItems: 1 }), "BUTCHR");

    await state.runTick([], deps, [capped]); // seed watermark

    membersByProject.BUTCHR = ["BUTCHR-1", "BUTCHR-2"]; // both just changed in the SAME window
    await state.runTick([], deps, [capped]); // maxLinkedItems: 1 keeps BUTCHR-1, drops BUTCHR-2
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason).map((e) => e.target)).toEqual(["BUTCHR-1"]);
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] project-member cap") && l.includes("BUTCHR"))).toBe(true);

    // Still in the SAME held window on the next tick (watermark did not advance) — with the cap
    // relieved, BUTCHR-2 (never lost) is now discoverable rather than having silently vanished.
    const relieved = projectMatch("jira-project:mgrs:BUTCHR", rule({ maxLinkedItems: 5 }), "BUTCHR");
    await state.runTick([], deps, [relieved]);
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason).map((e) => e.target)).toEqual(["BUTCHR-2"]); // BUTCHR-1 already baselined and unchanged since — only BUTCHR-2 is new
  });

  test("review round 2 regression: reviewer's own persistent-cap repro — maxLinkedItems stays fixed at 1 across many ticks (never relieved); both members eventually reported exactly once each, then the watermark resumes advancing once the backlog drains", async () => {
    // Round 1's fix (hold the watermark whenever ANY member is capped away)
    // still starved this exact case: with `ORDER BY updated ASC` alone, an
    // already-delivered member (now baselined, unchanged) kept re-matching
    // the deliberately over-inclusive held window and sorting right back to
    // the front, re-consuming the one scarce slot forever — B-2 in this
    // repro was never delivered even after 6 ticks. Round 2's fix ranks a
    // genuinely fresh-or-changed member ahead of an already-known,
    // unchanged one for the cap, so the already-delivered member falls out
    // of contention as soon as it is (whether or not it still re-matches
    // the window).
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = {
      "BUTCHR-1": issue("BUTCHR-1", { status: "Done" }), // each changed once, then never again
      "BUTCHR-2": issue("BUTCHR-2", { status: "Done" }),
    };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { deps, notified, logs, searchCalls } = fakeProjectDeps(world, membersByProject, { now });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule({ maxLinkedItems: 1 }), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark at now=0

    // Both changed once, in the SAME window, and — because a held watermark
    // widens the window rather than narrowing it — keep re-appearing in
    // every subsequent tick until the backlog actually drains, exactly like
    // a real Jira window search that has not advanced yet would.
    membersByProject.BUTCHR = ["BUTCHR-1", "BUTCHR-2"];
    for (let i = 0; i < 6 && notified.length < 2; i++) {
      now.value += 5 * 60_000; // +5 real minutes between ticks
      await state.runTick([], deps, [m]);
    }

    expect(notified).toHaveLength(2); // each reported EXACTLY once — not zero (starved), not more than once (duplicated)
    expect(notified.map((n) => linkedEvents(n.reason).map((e) => e.target)).flat().sort()).toEqual(["BUTCHR-1", "BUTCHR-2"]);
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] project-member cap"))).toBe(true);
    // Converged within 2 ticks of the cap actually biting (round 1's own
    // fix alone never converged at all under this exact scenario).
    expect(searchCalls.filter((q) => PROJECT_JQL_RE.test(q)).length).toBeLessThanOrEqual(3);

    // Backlog now fully drained (both baselined, both unchanged) — the
    // watermark must resume advancing rather than staying held forever.
    // Proven by the search window itself shrinking back down to roughly the
    // real elapsed time (a handful of minutes) instead of staying anchored
    // at tick 1's watermark (which would show as an ever-growing window,
    // ~20+ minutes by this point).
    membersByProject.BUTCHR = []; // nothing new — ages out for real now that the watermark can move past it
    now.value += 5 * 60_000;
    await state.runTick([], deps, [m]);
    const lastProjectSearch = [...searchCalls].reverse().find((q) => PROJECT_JQL_RE.test(q))!;
    const lastMinutes = Number(PROJECT_JQL_RE.exec(lastProjectSearch)![2]);
    expect(lastMinutes).toBeLessThanOrEqual(6); // a fresh ~5-minute window, not a stale, ever-widening one
    expect(notified).toHaveLength(2); // no further, spurious notification
  });

  test("a failed member search fails open: logged, skips member discovery for that owner only, managed links and other owners unaffected", async () => {
    const state = createLinkedEventingState();
    const store = fakeLinkStore();
    await addLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1"), "BUTCHR-2": issue("BUTCHR-2"), "OTHER-1": issue("OTHER-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: [], OTHER: [] };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { linkStore: store, failProjectSearchFor: new Set(["BUTCHR"]) });
    const bad = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");
    const good = projectMatch("jira-project:mgrs:OTHER", rule({ id: "other" }), "OTHER");

    await state.runTick([], deps, [bad, good]); // seed both watermarks
    await state.runTick([], deps, [bad, good]); // BUTCHR's member search fails; OTHER's succeeds (empty window); BUTCHR's managed link still seeds
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
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, notified, logs } = fakeProjectDeps(world, membersByProject, { linkStore: badStore });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // link-store fails (logged); member discovery still runs and reports BUTCHR-1's first appearance
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] managed-link fetch failed") && l.includes("BUTCHR"))).toBe(true);
    expect(notified).toHaveLength(1); // member discovery kept working despite the broken link store
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: expect.stringMatching(/^updated since /) }]);
  });

  test("comment events: a new comment on a project member (already baselined) is reported as 'got a new comment', the same mechanism an issue owner's linked target already uses", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { updated: "t1" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const commentsByKey: Record<string, JiraComment[]> = { "BUTCHR-1": [] };
    const { deps, notified } = fakeProjectDeps(world, membersByProject, { commentsByKey });
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark

    commentsByKey["BUTCHR-1"] = [{ id: "c1", body: "first", created: "t1", authorEmail: null }];
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // first appearance — reported (generic "updated since"), baseline (incl. commentCursor "c1") now set
    expect(notified).toHaveLength(1);

    world["BUTCHR-1"] = issue("BUTCHR-1", { updated: "t2" });
    commentsByKey["BUTCHR-1"] = [{ id: "c2", body: "second", created: "t2", authorEmail: null }, { id: "c1", body: "first", created: "t1", authorEmail: null }];
    membersByProject.BUTCHR = ["BUTCHR-1"]; // the new comment bumped `updated`, so it's back in the window
    await state.runTick([], deps, [m]);
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: "got a new comment" }]);
  });

  test("the member-discovery search's own already-fetched issue data is reused directly, without a second 'key in (...)' call for the same key", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const { deps, searchCalls } = fakeProjectDeps(world, membersByProject);
    const m = projectMatch("jira-project:mgrs:BUTCHR", rule(), "BUTCHR");

    await state.runTick([], deps, [m]); // seed watermark
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // BUTCHR-1's only Jira-kind target this tick is the member itself
    expect(searchCalls.some((q) => KEY_IN_RE.test(q))).toBe(false); // no redundant re-fetch — the member search already had the data
  });
});
