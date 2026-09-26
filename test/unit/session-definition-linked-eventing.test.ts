import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";
import { addLink, removeLink, type LinkStore } from "../../src/resources/link-store.js";
import { parseResourceRef, type ResourceRef } from "../../src/resources/resource-ref.js";
import type { FilesystemQuery } from "../../src/resources/filesystem-query.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import {
  builtinManagedSessionsRule, createManagedSessionResourceType, sessionDefinitionProjectMatches,
  type SessionDefinitionMatch,
} from "../../src/rules/session-definition-type.js";

/**
 * FACTORY-53/FACTORY-71: wires a managed-session definition's own
 * `linkedEventingProjects` (src/resources/session-definition.ts) into the
 * SAME `jira-project` linked-eventing machinery `test/unit/linked-eventing-project.test.ts`
 * already proves out — that machinery (coalescing, rate cap, member-discovery
 * watermark, managed-link removal tracking) is reused UNCHANGED and is NOT
 * re-tested here. This file covers only what is NEW: how a managed-session
 * definition's matches turn into `ProjectLinkedEventingMatch`es and reach the
 * real session agent's own notify target.
 */

const ref = (s: string): ResourceRef => parseResourceRef(s);
const res = (path: string, over: Partial<FilesystemResource> = {}): FilesystemResource =>
  ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000, ...over });
const goodDef = (over: Record<string, unknown> = {}) => ({
  workingDirectory: "/repo/project", brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "default", ...over,
});

function fakeFiles(files: Record<string, string>) {
  const list = async (_q: FilesystemQuery): Promise<FilesystemResource[]> => Object.keys(files).map((p) => res(p));
  const read = async (path: string): Promise<string> => {
    if (!(path in files)) throw new Error(`ENOENT: no such file ${path}`);
    return files[path]!;
  };
  return { list, read };
}

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const PROJECT_JQL_RE = /^project = (\S+) AND updated >= "-(\d+)m" ORDER BY updated ASC$/;
const KEY_IN_RE = /^key in \((.*)\)$/;

/** Mirrors `linked-eventing-project.test.ts`'s own `fakeProjectDeps`. */
function fakeLinkedEventingDeps(world: Record<string, JiraIssue>, membersByProject: Record<string, string[]>, opts: { linkStore?: LinkStore; isFrozen?: (id: string) => Promise<boolean> } = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const logs: string[] = [];
  const searchCalls: string[] = [];
  const search = async (jql: string): Promise<JiraIssue[]> => {
    searchCalls.push(jql);
    const keyIn = KEY_IN_RE.exec(jql);
    if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    const proj = PROJECT_JQL_RE.exec(jql);
    if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    throw new Error(`fakeLinkedEventingDeps: unexpected JQL ${JSON.stringify(jql)}`);
  };
  const notify = async (agent: string, about: string, reason: NotifyReason) => { notified.push({ agent, about, reason }); };
  return { searchIssues: search, notify, log: (l: string) => logs.push(l), ...(opts.linkStore ? { linkStore: opts.linkStore } : {}), ...(opts.isFrozen ? { isFrozen: opts.isFrozen } : {}), notified, logs, searchCalls };
}

function fakeLinkStore(initial: Record<string, string[]> = {}): LinkStore {
  const data: Record<string, string[]> = structuredClone(initial);
  return {
    async list(ownerKey) { return data[ownerKey] ?? []; },
    async add(ownerKey, targetKey) { const existing = data[ownerKey] ?? []; if (existing.includes(targetKey)) return false; data[ownerKey] = [...existing, targetKey]; return true; },
    async remove(ownerKey, targetKey) { const existing = data[ownerKey] ?? []; if (!existing.includes(targetKey)) return false; data[ownerKey] = existing.filter((t) => t !== targetKey); return true; },
  };
}

const sessionAgentKey = (path: string, ruleId = "managed-sessions") => encodeAgentKey({ resourceProvider: "filesystem", ruleId, resourceId: path });

describe("sessionDefinitionProjectMatches (pure)", () => {
  const match = (path: string, def: Record<string, unknown>): SessionDefinitionMatch => ({
    agentKey: sessionAgentKey(path),
    rule: builtinManagedSessionsRule("/defs"),
    resource: res(path),
    definition: { ...goodDef(), frozen: false, execution: "swarm", account: "none", role: "worker", ...def } as SessionDefinitionMatch["definition"],
  });

  test("a definition without linkedEventingProjects yields no matches", () => {
    expect(sessionDefinitionProjectMatches(match("/defs/a.json", {}))).toEqual([]);
  });

  test("one opted-in project yields one match: linkedEventing forced true, projectKey extracted, notifyAgentKey is the REAL session agent key", () => {
    const m = match("/defs/a.json", { linkedEventingProjects: ["jira-project:BUTCHR"] });
    const matches = sessionDefinitionProjectMatches(m);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.projectKey).toBe("BUTCHR");
    expect(matches[0]!.rule.linkedEventing).toBe(true);
    expect(matches[0]!.notifyAgentKey).toBe(m.agentKey);
    expect(matches[0]!.agentKey).not.toBe(m.agentKey); // synthetic state-owning key, never the real notify target
  });

  test("two opted-in projects yield two matches with DISTINCT state-owning agentKeys (no shared-key overwrite) but the SAME notifyAgentKey", () => {
    const m = match("/defs/a.json", { linkedEventingProjects: ["jira-project:AAA", "jira-project:BBB"] });
    const matches = sessionDefinitionProjectMatches(m);
    expect(matches).toHaveLength(2);
    expect(matches.map((x) => x.projectKey).sort()).toEqual(["AAA", "BBB"]);
    expect(new Set(matches.map((x) => x.agentKey)).size).toBe(2);
    expect(matches.every((x) => x.notifyAgentKey === m.agentKey)).toBe(true);
  });

  test("PR review (FACTORY-71): the produced rule carries no maxLinkedTurnsPerHour — a managed session's linked-eventing nudges are UNCAPPED BY DEFAULT today, the same 'absent means uncapped' behaviour an unconfigured jira-project rule already has. There is no per-definition or shared-constant cap value in production; a real default cap for managed-session directors is a known, deliberately-deferred gap tracked in FACTORY-78, not something this ticket invents.", () => {
    const m = match("/defs/a.json", { linkedEventingProjects: ["jira-project:BUTCHR"] });
    const [matched] = sessionDefinitionProjectMatches(m);
    expect(matched!.rule.maxLinkedTurnsPerHour).toBeUndefined();
    expect(matched!.rule.maxLinkedItems).toBeUndefined();
  });
});

describe("createManagedSessionResourceType: linked-eventing wiring (FACTORY-53/FACTORY-71)", () => {
  test("an opted-in definition's project-issue change nudges the REAL session agent, not the synthetic watch key", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:BUTCHR"] })) });
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const led = fakeLinkedEventingDeps(world, membersByProject);
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read, searchIssues: led.searchIssues, notify: led.notify, log: led.log });

    await type.discovery.search();
    await type.discovery.related?.([]); // seeds the watermark

    membersByProject.BUTCHR = ["BUTCHR-1"]; // the real change
    await type.discovery.search();
    await type.discovery.related?.([]);

    expect(led.notified).toHaveLength(1);
    expect(led.notified[0]!.agent).toBe(sessionAgentKey("/defs/a.json"));
  });

  test("a change to the project's own managed-link collection also nudges the session", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:BUTCHR"] })) });
    const store = fakeLinkStore();
    await addLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const led = fakeLinkedEventingDeps(world, {}, { linkStore: store });
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read, searchIssues: led.searchIssues, notify: led.notify, linkStore: store, log: led.log });

    await type.discovery.search();
    await type.discovery.related?.([]); // seeds watermark + managed-link baseline
    expect(led.notified).toHaveLength(0);

    await removeLink(store, ref("jira-project:BUTCHR"), ref("jira-work-item:BUTCHR-2"));
    await type.discovery.search();
    await type.discovery.related?.([]);

    expect(led.notified).toHaveLength(1);
    expect(led.notified[0]!.agent).toBe(sessionAgentKey("/defs/a.json"));
    const events = (led.notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;
    expect(events).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: "no longer linked" }]);
  });

  test("a definition with no linkedEventingProjects sees no behaviour change: zero linked-eventing searches, zero nudges", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef()) });
    const led = fakeLinkedEventingDeps({}, {});
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read, searchIssues: led.searchIssues, notify: led.notify, log: led.log });

    await type.discovery.search();
    await type.discovery.related?.([]);
    await type.discovery.search();
    await type.discovery.related?.([]);

    expect(led.searchCalls).toHaveLength(0);
    expect(led.notified).toHaveLength(0);
  });

  test("a FROZEN opted-in session is never nudged: no match is even built for it, so it costs no search either", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:BUTCHR"] })) });
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1") };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const led = fakeLinkedEventingDeps(world, membersByProject, { isFrozen: async () => true });
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read, searchIssues: led.searchIssues, notify: led.notify, isFrozen: async () => true, log: led.log });

    await type.discovery.search();
    await type.discovery.related?.([]);
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await type.discovery.search();
    await type.discovery.related?.([]);

    expect(led.searchCalls.filter((q) => PROJECT_JQL_RE.test(q))).toHaveLength(0);
    expect(led.notified).toHaveLength(0);
  });

  test("a session opted into TWO projects tracks both independently — neither's state overwrites the other's, and both nudges land on the SAME real session agent", async () => {
    const { list, read } = fakeFiles({ "/defs/a.json": JSON.stringify(goodDef({ linkedEventingProjects: ["jira-project:AAA", "jira-project:BBB"] })) });
    const world: Record<string, JiraIssue> = { "AAA-1": issue("AAA-1"), "BBB-1": issue("BBB-1") };
    const membersByProject: Record<string, string[]> = { AAA: [], BBB: [] };
    const led = fakeLinkedEventingDeps(world, membersByProject);
    const rule = builtinManagedSessionsRule("/defs");
    const type = createManagedSessionResourceType({ rule, list, read, searchIssues: led.searchIssues, notify: led.notify, log: led.log });

    await type.discovery.search();
    await type.discovery.related?.([]); // both seed
    await type.discovery.search();
    await type.discovery.related?.([]); // both search, both windows empty
    expect(led.notified).toHaveLength(0);

    membersByProject.AAA = ["AAA-1"]; // only AAA changed
    await type.discovery.search();
    await type.discovery.related?.([]);
    expect(led.notified).toHaveLength(1);
    expect(led.notified[0]!.agent).toBe(sessionAgentKey("/defs/a.json")); // still the REAL session agent, not a per-project synthetic key

    membersByProject.BBB = ["BBB-1"]; // now BBB changes too — must still be tracked (not lost to the earlier overwrite)
    await type.discovery.search();
    await type.discovery.related?.([]);
    expect(led.notified).toHaveLength(2);
    expect(led.notified[1]!.agent).toBe(sessionAgentKey("/defs/a.json"));
  });
});

/**
 * PR review (FACTORY-71): this describe block proves the BUTCHR-469 rate-cap
 * MECHANISM works correctly when a match's state-owning `agentKey` differs
 * from its `notifyAgentKey` — it does NOT prove managed sessions are
 * rate-capped in production. The match below hand-sets
 * `rule.maxLinkedTurnsPerHour: 1` directly, bypassing `sessionDefinitionProjectMatches`
 * entirely: that function never produces a rule with this field set (see
 * "the produced rule carries no maxLinkedTurnsPerHour" above) — in
 * production, a managed session's linked-eventing nudges are UNCAPPED BY
 * DEFAULT, same as an unconfigured `jira-project` rule owner. A real default
 * cap for managed-session directors is a known, deliberately-deferred gap —
 * see FACTORY-78 — not something this ticket invents.
 */
describe("rate-cap MECHANISM (not production defaults): the SAME sliding-window logic runTick already has still works correctly when keyed by a synthetic state-owning agentKey and delivered to a different notifyAgentKey", () => {
  test("a capped tick is suppressed and retried later, and every delivered notify still targets notifyAgentKey, never the synthetic agentKey", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const now = { value: 0 };
    const notified: Array<{ agent: string; about: string }> = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        const keyIn = KEY_IN_RE.exec(jql);
        if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        const proj = PROJECT_JQL_RE.exec(jql);
        if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        throw new Error(`unexpected JQL ${jql}`);
      },
      notify: async (agent, about) => { notified.push({ agent, about }); },
      now: () => now.value,
    };
    const realSessionAgent = sessionAgentKey("/defs/a.json");
    const m: ProjectLinkedEventingMatch = {
      agentKey: `${realSessionAgent}\0linked:jira-project:BUTCHR`,
      rule: { id: "x", enabled: true, resourceProvider: "filesystem", query: "{}", brief: "b", execution: "swarm", account: "none", role: "worker", linkedEventing: true, maxLinkedTurnsPerHour: 1 },
      projectKey: "BUTCHR",
      notifyAgentKey: realSessionAgent,
    };

    await state.runTick([], deps, [m]); // seed watermark
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [m]); // first appearance — uses the one allowed turn
    expect(notified).toHaveLength(1);
    expect(notified[0]!.agent).toBe(realSessionAgent); // delivered to the REAL agent, never the synthetic state key

    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "Done" });
    await state.runTick([], deps, [m]); // capped — dropped this tick, not lost
    expect(notified).toHaveLength(1);

    now.value += 61 * 60_000;
    await state.runTick([], deps, [m]); // the same outstanding change is re-detected and delivered
    expect(notified).toHaveLength(2);
    expect(notified[1]!.agent).toBe(realSessionAgent);
  });
});
