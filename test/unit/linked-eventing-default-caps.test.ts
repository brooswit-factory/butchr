import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { JiraProject } from "../../src/resources/jira-project.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import {
  createLinkedEventingState,
  DEFAULT_MAX_LINKED_ITEMS,
  type LinkedEventingDeps,
  type LinkedEventingMatch,
} from "../../src/jira-watch/linked-eventing.js";
import { createJiraProjectResourceType } from "../../src/rules/jira-project-type.js";

/**
 * BUTCHR-451/BUTCHR-471: no linked-eventing owner kind (jira-work, jira-project)
 * can end up on and
 * uncapped on linked ITEM COUNT, whether or not a rule sets its own
 * maxLinkedItems — this file's item-cap coverage below is UNCHANGED by
 * FACTORY-252. FACTORY-252 removed the companion hourly TURN-RATE cap
 * (`maxLinkedTurnsPerHour`/`DEFAULT_MAX_LINKED_TURNS_PER_HOUR`/
 * `effectiveMaxLinkedTurnsPerHour`) entirely, not merely defaulted — the
 * turn-cap describe blocks that once lived in this file are replaced below
 * with coverage proving no owner kind is throttled by turn rate any more,
 * including an owner whose rule still carries the old, now-ignored field
 * from before the cap was removed.
 */

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const FORMER_DEFAULT_MAX_LINKED_TURNS_PER_HOUR = 2; // the removed cap's own former default (BUTCHR-471) — a literal here, not an import, since the constant no longer exists

describe("FACTORY-252: the former hourly turn-rate cap is gone — jira-work owner, real rule parsing", () => {
  const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
    parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;
  const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

  function fakeDeps(world: Record<string, JiraIssue>, now: { value: number }) {
    const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
    const logs: string[] = [];
    const searchCalls: string[] = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        searchCalls.push(jql);
        const m = /^key in \((.*)\)$/.exec(jql);
        const keys = m ? m[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
      log: (l) => logs.push(l),
      now: () => now.value,
    };
    return { deps, notified, logs, searchCalls };
  }

  test("more real changes in one hour than the former default (2/hr) ever allowed all deliver immediately, with no [notify-suppressed] rate-capped line at all", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, now);
    const r = rule(); // no maxLinkedTurnsPerHour knob exists any more
    const m = () => match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m()], deps); // seed
    expect(notified).toHaveLength(0);

    const beyondFormerLimit = FORMER_DEFAULT_MAX_LINKED_TURNS_PER_HOUR + 3;
    for (let i = 0; i < beyondFormerLimit; i++) {
      world["BUTCHR-2"] = issue("BUTCHR-2", { status: `s${i}` });
      now.value += 1_000; // all well within the same hour
      await state.runTick([m()], deps);
    }
    expect(notified).toHaveLength(beyondFormerLimit); // every single one delivered, none withheld for a window to free
    expect(logs.some((l) => l.includes("rate-capped"))).toBe(false);
  });

  test("an already-deployed rule still carrying the old maxLinkedTurnsPerHour field (migration-only, parsed into nothing) is NOT throttled by it — old cap values must not silently keep throttling delivery", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, now);
    const r = rule({ maxLinkedTurnsPerHour: 1 }); // old persisted value — still loads (REMOVED_RULE_FIELDS), but means nothing now
    const m = () => match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m()], deps); // seed
    for (let i = 0; i < 5; i++) {
      world["BUTCHR-2"] = issue("BUTCHR-2", { status: `s${i}` });
      now.value += 1_000;
      await state.runTick([m()], deps);
    }
    expect(notified).toHaveLength(5); // far beyond the old field's own value of 1 — it is never read any more
    expect(logs.some((l) => l.includes("rate-capped"))).toBe(false);
  });
});

describe("BUTCHR-471: default item cap (25) — jira-work owner, real rule parsing, no explicit maxLinkedItems", () => {
  const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
    parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;
  const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

  test("more than DEFAULT_MAX_LINKED_ITEMS linked issues: only the default is polled, the rest are never fetched", async () => {
    expect(DEFAULT_MAX_LINKED_ITEMS).toBe(25);
    const total = DEFAULT_MAX_LINKED_ITEMS + 1;
    const issuelinks = Array.from({ length: total }, (_, i) => ({ type: "Blocks", otherEnd: "outward" as const, key: `BUTCHR-${i + 2}` }));
    const owner = issue("BUTCHR-1", { issuelinks: issuelinks as never });
    const world: Record<string, JiraIssue> = {};
    for (const l of issuelinks) world[l.key] = issue(l.key);
    const state = createLinkedEventingState();
    const searchCalls: string[] = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        searchCalls.push(jql);
        const m = /^key in \((.*)\)$/.exec(jql);
        const keys = m ? m[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async () => {},
    };
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // absent maxLinkedItems — the whole point
    expect(searchCalls).toHaveLength(1);
    const requested = /^key in \((.*)\)$/.exec(searchCalls[0]!)![1]!.split(",");
    expect(requested).toHaveLength(DEFAULT_MAX_LINKED_ITEMS);
  });
});

describe("BUTCHR-471: maxLinkedItems overrides always win over the default, in both directions", () => {
  const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
    parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;
  const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

  test("an explicit maxLinkedItems above and below the default is honoured", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-4" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2"), "BUTCHR-3": issue("BUTCHR-3"), "BUTCHR-4": issue("BUTCHR-4") };
    for (const cap of [1, 3]) {
      const searchCalls: string[] = [];
      const state = createLinkedEventingState();
      const deps: LinkedEventingDeps = {
        search: async (jql) => {
          searchCalls.push(jql);
          const m = /^key in \((.*)\)$/.exec(jql);
          const keys = m ? m[1]!.split(",") : [];
          return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        },
        notify: async () => {},
      };
      await state.runTick([match("jira-work:task:BUTCHR-1", rule({ maxLinkedItems: cap }), owner)], deps);
      const requested = /^key in \((.*)\)$/.exec(searchCalls[0]!)![1]!.split(",");
      expect(requested).toHaveLength(cap);
    }
  });
});

describe("FACTORY-252/BUTCHR-471: default caps for a jira-project owner, through createJiraProjectResourceType (the way the daemon actually builds it)", () => {
  function wire(rules: Rule[], world: Record<string, JiraIssue>, membersByProject: Record<string, string[]>, now: { value: number }) {
    const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
    const logs: string[] = [];
    const searchIssues = async (jql: string): Promise<JiraIssue[]> => {
      const keyIn = /^key in \((.*)\)$/.exec(jql);
      if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      const proj = /^project = (\S+) AND updated >= "-(\d+)m" ORDER BY updated ASC$/.exec(jql);
      if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      throw new Error(`unexpected JQL ${jql}`);
    };
    const type = createJiraProjectResourceType({
      rules,
      search: async (): Promise<JiraProject[]> => [{ id: "1", key: "BUTCHR", name: "Butchr" }],
      searchIssues,
      notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
      log: (l) => logs.push(l),
      now: () => now.value,
    });
    return { type, notified, logs };
  }

  test("no turn-rate cap: more deliveries than the former default (2/hr) ever allowed, all in the same hour, with no rate-capped suppression line", async () => {
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified, logs } = wire(parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true }] }), world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related!([]); // seeds the watermark

    const beyondFormerLimit = FORMER_DEFAULT_MAX_LINKED_TURNS_PER_HOUR + 3;
    for (let i = 0; i < beyondFormerLimit; i++) {
      membersByProject.BUTCHR = ["BUTCHR-1"];
      world["BUTCHR-1"] = issue("BUTCHR-1", { status: `s${i}` });
      now.value += 1_000;
      await type.discovery.search();
      await type.discovery.related!([]);
    }
    expect(notified).toHaveLength(beyondFormerLimit);
    expect(logs.some((l) => l.includes("rate-capped"))).toBe(false);
  });

  test("no explicit maxLinkedItems: more than DEFAULT_MAX_LINKED_ITEMS members changing in one window keeps only the default and logs the effective value (never 'undefined')", async () => {
    const total = DEFAULT_MAX_LINKED_ITEMS + 1;
    const world: Record<string, JiraIssue> = {};
    for (let i = 0; i < total; i++) world[`BUTCHR-${i + 1}`] = issue(`BUTCHR-${i + 1}`, { status: "To Do" });
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified, logs } = wire(parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true }] }), world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related!([]); // seed

    membersByProject.BUTCHR = Object.keys(world); // all change in the same window
    await type.discovery.search();
    await type.discovery.related!([]);

    expect(notified).toHaveLength(1); // coalesced into one nudge
    const events = (notified[0]!.reason as { linked: { events: readonly { target: string }[] } }).linked.events;
    expect(events).toHaveLength(DEFAULT_MAX_LINKED_ITEMS); // only the default kept
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] project-member cap") && l.includes(`maxLinkedItems (${DEFAULT_MAX_LINKED_ITEMS})`))).toBe(true);
    expect(logs.some((l) => l.includes("maxLinkedItems (undefined)"))).toBe(false); // never print the literal absence
  });

  test("an old persisted maxLinkedTurnsPerHour on a jira-project rule (migration-only) no longer throttles delivery at all", async () => {
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified } = wire(parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true, maxLinkedTurnsPerHour: 1 }] }), world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related!([]); // seed
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await type.discovery.search();
    await type.discovery.related!([]);
    expect(notified).toHaveLength(1);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" });
    now.value += 1_000;
    await type.discovery.search();
    await type.discovery.related!([]); // the old field's own value of 1 would have capped this; it no longer does
    expect(notified).toHaveLength(2);
  });
});
