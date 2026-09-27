import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { JiraProject } from "../../src/resources/jira-project.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import {
  createLinkedEventingState,
  DEFAULT_MAX_LINKED_ITEMS,
  DEFAULT_MAX_LINKED_TURNS_PER_HOUR,
  type LinkedEventingDeps,
  type LinkedEventingMatch,
} from "../../src/jira-watch/linked-eventing.js";
import { createJiraProjectResourceType } from "../../src/rules/jira-project-type.js";
import { builtinManagedSessionsRule, createManagedSessionResourceType } from "../../src/rules/session-definition-type.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";

/**
 * BUTCHR-451/BUTCHR-471: no linked-eventing owner kind (jira-work, jira-project,
 * a managed session opted in via linkedEventingProjects) can end up on and
 * uncapped, whether or not a rule sets its own maxLinkedTurnsPerHour/
 * maxLinkedItems. Each owner kind below is exercised through its REAL
 * production wiring (real rule parsing / real resource-type constructor),
 * never a hand-built match or a fixture that hand-sets a cap it wouldn't
 * actually carry in production — the point is to prove the ENFORCEMENT
 * SITE'S default covers every owner kind, not just the mechanism.
 */

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

describe("BUTCHR-471: default turn cap (2/hr) — jira-work owner, real rule parsing, no explicit cap", () => {
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

  test("a rule with linkedEventing:true and NO maxLinkedTurnsPerHour delivers exactly DEFAULT_MAX_LINKED_TURNS_PER_HOUR turns/hour, suppresses the next with a [notify-suppressed] rate-capped line, then delivers the still-outstanding change once the window slides (delayed, not lost)", async () => {
    expect(DEFAULT_MAX_LINKED_TURNS_PER_HOUR).toBe(2);
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, now);
    const r = rule(); // absent maxLinkedTurnsPerHour — the whole point
    const m = () => match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m()], deps); // seed
    expect(notified).toHaveLength(0);

    for (let i = 0; i < DEFAULT_MAX_LINKED_TURNS_PER_HOUR; i++) {
      world["BUTCHR-2"] = issue("BUTCHR-2", { status: `s${i}` });
      await state.runTick([m()], deps);
    }
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR); // both allowed turns delivered

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "still-outstanding" });
    await state.runTick([m()], deps); // one turn beyond the default — must be capped
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR); // not delivered
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes(`max=${DEFAULT_MAX_LINKED_TURNS_PER_HOUR}`))).toBe(true);

    now.value += 61 * 60_000; // roll the sliding window over
    await state.runTick([m()], deps); // the outstanding change is re-detected and delivered, never lost
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR + 1);
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

describe("BUTCHR-471: overrides always win over the default, in both directions", () => {
  const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
    parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;
  const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

  test("an explicit maxLinkedTurnsPerHour BELOW the default (1) caps tighter than the default would", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const notified: unknown[] = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        const m = /^key in \((.*)\)$/.exec(jql);
        const keys = m ? m[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async (...args) => { notified.push(args); },
      now: () => now.value,
    };
    const r = rule({ maxLinkedTurnsPerHour: 1 }); // below DEFAULT_MAX_LINKED_TURNS_PER_HOUR (2)
    const m = () => match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m()], deps); // seed
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "s1" });
    await state.runTick([m()], deps); // uses the one allowed turn
    expect(notified).toHaveLength(1);
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "s2" });
    await state.runTick([m()], deps); // would be allowed under the default (2/hr) but the explicit 1 caps it
    expect(notified).toHaveLength(1);
  });

  test("an explicit maxLinkedTurnsPerHour ABOVE the default (4) allows more than the default would", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const notified: unknown[] = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        const m = /^key in \((.*)\)$/.exec(jql);
        const keys = m ? m[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async (...args) => { notified.push(args); },
      now: () => now.value,
    };
    const r = rule({ maxLinkedTurnsPerHour: 4 }); // above DEFAULT_MAX_LINKED_TURNS_PER_HOUR (2)
    const m = () => match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m()], deps); // seed
    for (let i = 0; i < 4; i++) {
      world["BUTCHR-2"] = issue("BUTCHR-2", { status: `s${i}` });
      await state.runTick([m()], deps);
    }
    expect(notified).toHaveLength(4); // more than the default (2) would ever allow in one hour
  });

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

describe("BUTCHR-471: default caps for a jira-project owner, through createJiraProjectResourceType (the way the daemon actually builds it)", () => {
  const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
    parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true, ...over }] })[0]!;

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

  test("no explicit maxLinkedTurnsPerHour: exactly DEFAULT_MAX_LINKED_TURNS_PER_HOUR deliveries per hour, then rate-capped, then delivered once the window slides", async () => {
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified, logs } = wire(parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true }] }), world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related!([]); // seeds the watermark

    for (let i = 0; i < DEFAULT_MAX_LINKED_TURNS_PER_HOUR; i++) {
      membersByProject.BUTCHR = [`BUTCHR-${i === 0 ? 1 : "1"}`]; // BUTCHR-1 changes each round
      world["BUTCHR-1"] = issue("BUTCHR-1", { status: `s${i}` });
      await type.discovery.search();
      await type.discovery.related!([]);
    }
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "still-outstanding" });
    await type.discovery.search();
    await type.discovery.related!([]); // one turn beyond the default — capped
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR);
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes(`max=${DEFAULT_MAX_LINKED_TURNS_PER_HOUR}`))).toBe(true);

    now.value += 61 * 60_000;
    await type.discovery.search();
    await type.discovery.related!([]); // re-detected and delivered, not lost
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR + 1);
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

  test("an explicit maxLinkedTurnsPerHour still overrides the default for a jira-project owner", async () => {
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified } = wire(parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage", linkedEventing: true, maxLinkedTurnsPerHour: 1 }] }), world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related!([]); // seed
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await type.discovery.search();
    await type.discovery.related!([]); // uses the one allowed turn
    expect(notified).toHaveLength(1);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" });
    await type.discovery.search();
    await type.discovery.related!([]); // the default (2) would allow this; the explicit 1 caps it
    expect(notified).toHaveLength(1);
  });
});

describe("BUTCHR-471: default caps for a managed session, through createManagedSessionResourceType with discovery.search then discovery.related (the way FACTORY-53/71 actually wires it) — NOT a hand-built ProjectLinkedEventingMatch, NOT a fixture that hand-sets a cap", () => {
  const goodDef = (over: Record<string, unknown> = {}) => ({
    workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default",
    frozen: false, execution: "swarm", account: "none", role: "worker", ...over,
  });

  function fakeFiles(files: Record<string, string>) {
    const list = async (_q: FilesystemQuery): Promise<FilesystemResource[]> =>
      Object.keys(files).map((path) => ({ path, kind: "file" as const, name: path.split("/").pop()!, size: 10, mtimeMs: 1000 }));
    const read = async (path: string): Promise<string> => {
      if (!(path in files)) throw new Error(`ENOENT: no such file ${path}`);
      return files[path]!;
    };
    return { list, read };
  }

  const sessionAgentKey = (path: string) => encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: path });

  function wire(files: Record<string, string>, world: Record<string, JiraIssue>, membersByProject: Record<string, string[]>, now: { value: number }) {
    const { list, read } = fakeFiles(files);
    const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
    const logs: string[] = [];
    const searchIssues = async (jql: string): Promise<JiraIssue[]> => {
      const keyIn = /^key in \((.*)\)$/.exec(jql);
      if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      const proj = /^project = (\S+) AND updated >= "-(\d+)m" ORDER BY updated ASC$/.exec(jql);
      if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      throw new Error(`unexpected JQL ${jql}`);
    };
    const type = createManagedSessionResourceType({
      rule: builtinManagedSessionsRule("/defs"),
      list, read, searchIssues,
      notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
      log: (l) => logs.push(l),
      now: () => now.value,
    });
    return { type, notified, logs };
  }

  test("a definition naming linkedEventingProjects, with no per-definition cap field at all (none exists), delivers at most DEFAULT_MAX_LINKED_TURNS_PER_HOUR turns/hour and defers the rest — the MANAGED_SESSION_LINKED_EVENTING_RULE gap this ticket closes", async () => {
    const files = { "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:BUTCHR"] })) };
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified, logs } = wire(files, world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related?.([]); // seeds the watermark

    for (let i = 0; i < DEFAULT_MAX_LINKED_TURNS_PER_HOUR; i++) {
      world["BUTCHR-1"] = issue("BUTCHR-1", { status: `s${i}` });
      membersByProject.BUTCHR = ["BUTCHR-1"];
      await type.discovery.search();
      await type.discovery.related?.([]);
    }
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR);
    expect(notified.every((n) => n.agent === sessionAgentKey("/defs/a.json"))).toBe(true);

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "still-outstanding" });
    await type.discovery.search();
    await type.discovery.related?.([]); // one turn beyond the default — MUST be capped, unlike before this ticket
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR);
    // The emitted suppressed line must carry the REAL session agent, never the synthetic NUL-bearing state key (BUTCHR-471 item 6).
    const suppressedLine = logs.find((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped"));
    expect(suppressedLine).toBeDefined();
    expect(suppressedLine).toContain(`watcher=${sessionAgentKey("/defs/a.json")}`);
    expect(suppressedLine).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/); // no NUL byte, no control character

    now.value += 61 * 60_000;
    await type.discovery.search();
    await type.discovery.related?.([]); // delayed, not lost
    expect(notified).toHaveLength(DEFAULT_MAX_LINKED_TURNS_PER_HOUR + 1);
  });

  test("a definition naming linkedEventingProjects with more than DEFAULT_MAX_LINKED_ITEMS members changing in one window keeps only the default", async () => {
    const files = { "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:BUTCHR"] })) };
    const total = DEFAULT_MAX_LINKED_ITEMS + 1;
    const world: Record<string, JiraIssue> = {};
    for (let i = 0; i < total; i++) world[`BUTCHR-${i + 1}`] = issue(`BUTCHR-${i + 1}`, { status: "To Do" });
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const { type, notified } = wire(files, world, membersByProject, now);

    await type.discovery.search();
    await type.discovery.related?.([]); // seed

    membersByProject.BUTCHR = Object.keys(world);
    await type.discovery.search();
    await type.discovery.related?.([]);

    expect(notified).toHaveLength(1);
    const events = (notified[0]!.reason as { linked: { events: readonly { target: string }[] } }).linked.events;
    expect(events).toHaveLength(DEFAULT_MAX_LINKED_ITEMS);
  });
});
