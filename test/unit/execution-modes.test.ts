import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import { desiredFrom, reconcileNow, scopedHerd } from "../../src/daemon/loop.js";
import { createOwnWriteLedger } from "../../src/jira-watch/own-writes.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import {
  createRuleEventRules, createRuleResourceType, ownsRuleAgent, relatedForRules, specForMatch, specForRuleQuery, specForUnit, uniqueIssues, type RuleMatch,
} from "../../src/rules/resource-type.js";
import { createGithubIssueEventRules, createGithubIssueResourceType, specForGithubIssueQuery, specForGithubIssueUnit, type GithubIssueMatch } from "../../src/rules/github-issue-type.js";
import { createZendeskTicketEventRules, createZendeskTicketResourceType, specForZendeskTicketQuery, specForZendeskTicketUnit, type ZendeskTicketMatch } from "../../src/rules/zendesk-ticket-type.js";
import { createJiraIdeaResourceType } from "../../src/rules/jira-idea-type.js";
import type { ResourceType } from "../../src/resources/types.js";
import type { GithubIssue } from "../../src/resources/github-issue.js";
import { parseGithubIssueRef } from "../../src/resources/github-issue-ref.js";
import type { ZendeskTicket } from "../../src/resources/zendesk-ticket.js";
import { parseZendeskTicketRef } from "../../src/resources/zendesk-ticket-ref.js";
import { decodeAnyAgentKey, decodeQueryAgentKey, encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { groupExecutionUnits, logExecutionModeSwitches, mergeRelated, scopeRelated, scopeRelatedResources, type ExecutionUnit } from "../../src/rules/execution.js";
import { createAdmissionController, type AgentCapacityRole } from "../../src/agents/admission.js";
import { resourceKeyOf } from "../../src/agents/workspace.js";

/**
 * BUTCHR-398 — reconciliation and event delivery for `execution:
 * "singleton" | "persistent"` rules (BUTCHR-397 shipped the schema field,
 * the codec, and the identity plumbing only; nothing here could have passed
 * before this ticket — `groupExecutionUnits`, `scopeRelated`/
 * `scopeRelatedResources`, `logExecutionModeSwitches` and
 * `AdmissionControllerDeps.roleOf`/`Rule.role` are all NEW exports this
 * ticket adds. Verified live: `git show origin/BUTCHR-392:src/rules/rules.ts`
 * has no `role` field and `git show origin/BUTCHR-392:src/rules/execution.ts`
 * does not exist at all — every test below imports from one or the other, so
 * the whole file fails to even load against pre-change `BUTCHR-392`, let
 * alone pass.
 */

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue =>
  ({ key, status: "In Progress", summary: `summary of ${key}`, issuetype: "Task", assignee: "me", parent: null, updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over });

const rules = (...docs: object[]): Rule[] =>
  parseRules({ rules: docs.map((d) => ({ resourceProvider: "jira-work", brief: "do it", ...d })) });

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; specs: Map<string, SpawnSpec> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  const specs = new Map<string, SpawnSpec>();
  return {
    spawned, stopped, specs,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); specs.set(sp.key, sp); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

/** One reconcile pass exactly as `runResourceLoop` performs it, returning the poll's primary units for inspection. */
async function poll(herd: Herd, ruleSet: Rule[], search: (jql: string) => Promise<JiraIssue[]>): Promise<ExecutionUnit<RuleMatch>[]> {
  const type = createRuleResourceType({ rules: ruleSet, search });
  const units = await type.discovery.search();
  await reconcileNow(scopedHerd(herd, ownsRuleAgent), desiredFrom(units, type));
  return units;
}

const queryKey = (ruleId: string) => encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId });
const queryKey2 = (resourceProvider: "jira-work" | "github-issue" | "jira-idea" | "zendesk-ticket", ruleId: string) => encodeQueryAgentKey({ resourceProvider, ruleId });

describe("groupExecutionUnits (BUTCHR-398) — the primary-item grouping every provider's discovery.search() shares", () => {
  const rule = (id: string, execution: Rule["execution"], enabled = true): Rule =>
    ({ id, enabled, resourceProvider: "jira-work", query: "q", brief: "b", execution, account: "none", role: "worker" });
  const match = (rule: Rule, key: string): RuleMatch => ({ agentKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: rule.id, resourceId: key }), rule, issue: issue(key) });

  test("swarm: byte-for-byte today's behaviour — one resource-kind unit per match, none when nothing matches", () => {
    const r = rule("task", "swarm");
    expect(groupExecutionUnits([r], [match(r, "BUTCHR-1"), match(r, "BUTCHR-2")])).toEqual([
      { kind: "resource", match: match(r, "BUTCHR-1") },
      { kind: "resource", match: match(r, "BUTCHR-2") },
    ]);
    expect(groupExecutionUnits([r], [])).toEqual([]);
  });

  test("singleton: one query-kind unit while N>=1, none at N=0", () => {
    const r = rule("task", "singleton");
    expect(groupExecutionUnits([r], [match(r, "BUTCHR-1"), match(r, "BUTCHR-2")])).toEqual([{ kind: "query", agentKey: queryKey("task"), rule: r }]);
    expect(groupExecutionUnits([r], [])).toEqual([]);
  });

  test("persistent: one query-kind unit always, even at N=0", () => {
    const r = rule("task", "persistent");
    expect(groupExecutionUnits([r], [])).toEqual([{ kind: "query", agentKey: queryKey("task"), rule: r }]);
    expect(groupExecutionUnits([r], [match(r, "BUTCHR-1")])).toEqual([{ kind: "query", agentKey: queryKey("task"), rule: r }]);
  });

  test("a disabled rule (the freeze/off path) is simply absent from allEnabledRules — callers filter before calling, so it contributes no unit at all, swarm/singleton/persistent alike", () => {
    for (const execution of ["swarm", "singleton", "persistent"] as const) {
      const r = rule("task", execution, false);
      const enabledOnly = [r].filter((x) => x.enabled); // exactly what searchRules'/each *-type.ts's own `enabled` filter already does
      expect(groupExecutionUnits(enabledOnly, [])).toEqual([]);
      expect(groupExecutionUnits(enabledOnly, [match(r, "BUTCHR-1")])).toEqual([]);
    }
  });

  test("never duplicates: exactly one unit per rule, regardless of how many matches a singleton/persistent rule has", () => {
    const r = rule("task", "persistent");
    const many = Array.from({ length: 50 }, (_, i) => match(r, `BUTCHR-${i}`));
    const units = groupExecutionUnits([r], many);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({ kind: "query", agentKey: queryKey("task"), rule: r });
  });
});

describe("the query-level SpawnSpec, per provider (BUTCHR-398)", () => {
  const jiraRule: Rule = { id: "triage", enabled: true, resourceProvider: "jira-work", query: 'status = "In Progress"', brief: "Triage the queue.", execution: "singleton", account: "none", role: "worker" };
  const ghRule: Rule = { id: "bugs", enabled: true, resourceProvider: "github-issue", query: "is:open label:bug", brief: "Fix bugs.", execution: "persistent", account: "none", role: "worker" };
  const zdRule: Rule = { id: "support", enabled: true, resourceProvider: "zendesk-ticket", query: "status:open", brief: "Triage tickets.", execution: "singleton", account: "none", role: "worker" };

  test("no single resource: `resource` is never set, so mcpIdentityHeaders/buildWorkspace can never resolve one for it", () => {
    for (const spec of [specForRuleQuery(jiraRule, queryKey("triage")), specForGithubIssueQuery(ghRule, "github-issue:bugs:%40query"), specForZendeskTicketQuery(zdRule, "zendesk-ticket:support:%40query")]) {
      expect(spec).not.toHaveProperty("resource");
      expect(spec.parent).toBeNull();
    }
  });

  test("brief is always the rule's own; issuetype is a generic default (query agents have no real issue type)", () => {
    expect(specForRuleQuery(jiraRule, queryKey("triage"))).toMatchObject({ brief: "Triage the queue.", issuetype: "task", key: queryKey("triage") });
    expect(specForGithubIssueQuery(ghRule, "x")).toMatchObject({ brief: "Fix bugs.", issuetype: "task" });
    expect(specForZendeskTicketQuery(zdRule, "x")).toMatchObject({ brief: "Triage tickets.", issuetype: "task" });
  });

  test("agentPreferences carry through from the rule, same as a per-resource spec", () => {
    const withPrefs: Rule = { ...jiraRule, agentPreferences: [{ harness: "codex" }] };
    expect(specForRuleQuery(withPrefs, queryKey("triage")).agents).toEqual([{ harness: "codex" }]);
  });

  test("specForUnit/specForGithubIssueUnit/specForZendeskTicketUnit dispatch on unit kind — resource-kind still spawns today's per-resource spec unchanged", () => {
    const jm: RuleMatch = { agentKey: "jira-work:triage:BUTCHR-1", rule: jiraRule, issue: issue("BUTCHR-1") };
    expect(specForUnit({ kind: "resource", match: jm })).toEqual(specForMatch(jm));
    expect(specForUnit({ kind: "query", agentKey: queryKey("triage"), rule: jiraRule })).toEqual(specForRuleQuery(jiraRule, queryKey("triage")));

    const gm: GithubIssueMatch = { agentKey: "github-issue:bugs:acme%2Fw%231", rule: ghRule, issue: { ref: "acme/w#1", owner: "acme", repo: "w", number: 1, title: "t", body: "b", state: "open", stateReason: null, issueType: "Bug", labels: [], comments: 0, updated: "t", url: "https://github.com/acme/w/issues/1" } };
    expect(specForGithubIssueUnit({ kind: "resource", match: gm })).toEqual({ key: gm.agentKey, resource: "acme/w#1", issuetype: "bug", summary: "t", parent: null, brief: "Fix bugs.", agents: undefined } as never);
    expect(specForGithubIssueUnit({ kind: "query", agentKey: "x", rule: ghRule })).toEqual(specForGithubIssueQuery(ghRule, "x"));

    const zm: ZendeskTicketMatch = { agentKey: "zendesk-ticket:support:acme%237", rule: zdRule, ticket: { ref: "acme#7", id: 7, subject: "s", description: "d", status: "open", priority: "normal", ticketType: null, tags: [], updated: "t", url: "https://acme.zendesk.com/agent/tickets/7" } };
    expect(specForZendeskTicketUnit({ kind: "resource", match: zm }).resource).toBe("acme#7");
    expect(specForZendeskTicketUnit({ kind: "query", agentKey: "x", rule: zdRule })).toEqual(specForZendeskTicketQuery(zdRule, "x"));
  });
});

describe("scopeRelated / scopeRelatedResources (BUTCHR-398) — the event-delivery mechanism for a query-level agent's scope", () => {
  const singletonRule: Rule = { id: "triage", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "singleton", account: "none", role: "worker" };
  const swarmRule: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker" };
  const m = (rule: Rule, key: string): RuleMatch => ({ agentKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: rule.id, resourceId: key }), rule, issue: issue(key) });

  test("a swarm rule's matches contribute NOTHING to scope-related — its own agents hear their own changes directly, no watcher relationship needed", () => {
    expect(scopeRelated([m(swarmRule, "BUTCHR-1")])).toEqual([]);
    expect(scopeRelatedResources([m(swarmRule, "BUTCHR-1")])).toEqual([]);
  });

  test("a singleton/persistent rule's every currently-matched resource is watched by exactly its own query agent key", () => {
    const matches = [m(singletonRule, "BUTCHR-1"), m(singletonRule, "BUTCHR-2")];
    expect(scopeRelated(matches)).toEqual([
      { match: matches[0]!, watcher: queryKey("triage") },
      { match: matches[1]!, watcher: queryKey("triage") },
    ]);
    expect(scopeRelatedResources(matches)).toEqual([
      { issue: { kind: "resource", match: matches[0]! }, watchers: [queryKey("triage")] },
      { issue: { kind: "resource", match: matches[1]! }, watchers: [queryKey("triage")] },
    ]);
  });

  test("mergeRelated unions watchers per resource id across two independent related sources", () => {
    const a = m(singletonRule, "BUTCHR-1");
    const idOf = (u: ExecutionUnit<RuleMatch>) => (u.kind === "resource" ? u.match.issue.key : u.agentKey);
    const source1 = [{ issue: { kind: "resource" as const, match: a }, watchers: ["watcher-A"] }];
    const source2 = [{ issue: { kind: "resource" as const, match: a }, watchers: ["watcher-B", "watcher-A"] }];
    expect(mergeRelated(idOf, source1, source2)).toEqual([{ issue: { kind: "resource", match: a }, watchers: ["watcher-A", "watcher-B"] }]);
  });
});

describe("logExecutionModeSwitches (BUTCHR-398) — BUTCHR-370-class rename-safety, loud not silent", () => {
  test("a running per-resource agent whose rule switched away from swarm is logged, once per id", () => {
    const r: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "singleton", account: "none", role: "worker" };
    const lines: string[] = [];
    logExecutionModeSwitches("jira-work", [r], ["jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-2"], decodeAnyAgentKey, (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("WARNING: [execution-mode]");
      expect(l).toContain('rule "task" switched away from swarm to "singleton"');
    }
  });

  test("a running query-level agent whose rule switched TO swarm is logged", () => {
    const r: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker" };
    const lines: string[] = [];
    logExecutionModeSwitches("jira-work", [r], [queryKey("task")], decodeAnyAgentKey, (l) => lines.push(l));
    expect(lines).toEqual([expect.stringContaining('rule "task" switched to swarm')]);
  });

  test("no switch: a per-resource id under a swarm rule, or a query-level id under a singleton/persistent rule, is silent", () => {
    const swarmR: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker" };
    const singletonR: Rule = { id: "triage", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "singleton", account: "none", role: "worker" };
    const lines: string[] = [];
    logExecutionModeSwitches("jira-work", [swarmR, singletonR], ["jira-work:task:BUTCHR-1", queryKey("triage")], decodeAnyAgentKey, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  test("an id whose rule cannot be resolved (removed rule, legacy id) is silent — a different, separately-logged story", () => {
    const lines: string[] = [];
    logExecutionModeSwitches("jira-work", [], ["jira-work:gone:BUTCHR-1", "BUTCHR-1"], decodeAnyAgentKey, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  test("no `log` dependency: never throws, simply does nothing", () => {
    expect(() => logExecutionModeSwitches("jira-work", [], ["jira-work:task:BUTCHR-1"], decodeAnyAgentKey, undefined)).not.toThrow();
  });
});

describe("reconciliation converges on N / 0-or-1 / 1 (BUTCHR-398)", () => {
  test("swarm regression: unchanged byte-for-byte — N matches, N agents, none when nothing matches", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "task", query: "q", execution: "swarm" });
    await poll(herd, ruleSet, async () => [issue("BUTCHR-1"), issue("BUTCHR-2")]);
    expect(herd.spawned.sort()).toEqual(["jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-2"]);
    await poll(herd, ruleSet, async () => []);
    expect(herd.stopped.sort()).toEqual(["jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-2"]);
  });

  test("singleton: 0 matches spawns nothing; N>=1 spawns EXACTLY ONE query-level agent regardless of N", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "triage", query: "q", execution: "singleton" });
    await poll(herd, ruleSet, async () => []);
    expect(herd.spawned).toEqual([]);
    await poll(herd, ruleSet, async () => [issue("BUTCHR-1"), issue("BUTCHR-2"), issue("BUTCHR-3")]);
    expect(herd.spawned).toEqual([queryKey("triage")]);
    // A second poll with a DIFFERENT match count still doesn't spawn a second agent — already running.
    await poll(herd, ruleSet, async () => [issue("BUTCHR-4")]);
    expect(herd.spawned).toEqual([queryKey("triage")]);
  });

  test("singleton: N -> 0 -> k -> 0 — stops at zero, restarts when matches return, never a duplicate", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "triage", query: "q", execution: "singleton" });
    await poll(herd, ruleSet, async () => [issue("BUTCHR-1")]);
    expect(herd.spawned).toEqual([queryKey("triage")]);
    await poll(herd, ruleSet, async () => []);
    expect(herd.stopped).toEqual([queryKey("triage")]);
    await poll(herd, ruleSet, async () => [issue("BUTCHR-2")]);
    expect(herd.spawned).toEqual([queryKey("triage"), queryKey("triage")]); // spawned twice across its lifetime, never concurrently
    await poll(herd, ruleSet, async () => []);
    expect(herd.stopped).toEqual([queryKey("triage"), queryKey("triage")]);
  });

  test("persistent: exactly one agent even at N=0 — never spawned twice, never stopped by matches leaving", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "director", query: "q", execution: "persistent" });
    await poll(herd, ruleSet, async () => []);
    expect(herd.spawned).toEqual([queryKey("director")]);
    await poll(herd, ruleSet, async () => [issue("BUTCHR-1"), issue("BUTCHR-2")]);
    expect(herd.spawned).toEqual([queryKey("director")]); // still just the one spawn
    expect(herd.stopped).toEqual([]);
    await poll(herd, ruleSet, async () => []);
    expect(herd.spawned).toEqual([queryKey("director")]);
    expect(herd.stopped).toEqual([]); // matches leaving does NOT stop a persistent agent
  });

  test("persistent: an explicit freeze (enabled: false) stops it — the only thing that does", async () => {
    const herd = fakeHerd();
    const on = rules({ id: "director", query: "q", execution: "persistent" });
    await poll(herd, on, async () => []);
    expect(herd.spawned).toEqual([queryKey("director")]);
    const off = rules({ id: "director", query: "q", execution: "persistent", enabled: false });
    await poll(herd, off, async () => { throw new Error("a disabled rule must never be searched"); });
    expect(herd.stopped).toEqual([queryKey("director")]);
  });

  test("restart adoption: an already-running query-level agent is adopted, never re-spawned, across every mode", async () => {
    for (const execution of ["singleton", "persistent"] as const) {
      const herd = fakeHerd([queryKey("triage")]); // simulates the daemon restarting with the agent already alive
      const ruleSet = rules({ id: "triage", query: "q", execution });
      await poll(herd, ruleSet, async () => [issue("BUTCHR-1"), issue("BUTCHR-2")]);
      expect(herd.spawned).toEqual([]); // adopted, not re-spawned
      expect(herd.stopped).toEqual([]);
    }
  });

  test("a failed poll (search rejects) changes nothing — same partial-result discipline searchRules already has; never reads as N=0 and stops/spawns anything", async () => {
    const herd = fakeHerd([queryKey("triage")]);
    const ruleSet = rules({ id: "triage", query: "q", execution: "persistent" });
    const type = createRuleResourceType({ rules: ruleSet, search: async () => { throw new Error("Jira is down"); } });
    await expect(type.discovery.search()).rejects.toThrow("Jira is down");
    // No spawn/stop ever reaches the herd — reconcileNow was never even called with a partial/empty desired set.
    expect(herd.spawned).toEqual([]);
    expect(herd.stopped).toEqual([]);
  });

  test("switching a rule's mode (swarm -> singleton) is handled deliberately: the old per-resource agent is stopped and the one query agent starts, in the same poll, never a duplicate of either shape", async () => {
    const herd = fakeHerd();
    const swarmRules = rules({ id: "triage", query: "q", execution: "swarm" });
    await poll(herd, swarmRules, async () => [issue("BUTCHR-1")]);
    expect(herd.spawned).toEqual(["jira-work:triage:BUTCHR-1"]);

    const lines: string[] = [];
    const singletonRules = rules({ id: "triage", query: "q", execution: "singleton" });
    const type = createRuleResourceType({
      rules: singletonRules, search: async () => [issue("BUTCHR-1")],
      log: (l) => lines.push(l),
      runningIds: async () => (await herd.runningIssues()).filter(ownsRuleAgent),
    });
    const units = await type.discovery.search();
    await reconcileNow(scopedHerd(herd, ownsRuleAgent), desiredFrom(units, type));

    expect(herd.stopped).toEqual(["jira-work:triage:BUTCHR-1"]);
    expect(herd.spawned).toEqual(["jira-work:triage:BUTCHR-1", queryKey("triage")]);
    expect(lines.some((l) => l.includes("WARNING: [execution-mode]") && l.includes('switched away from swarm to "singleton"'))).toBe(true);
  });
});

describe("event delivery to a query-level agent's scope (BUTCHR-398)", () => {
  const ruleSet = rules({ id: "triage", query: "q", execution: "singleton" });
  const [triage] = ruleSet;

  test("a resource entering the query is a 'create' — delivered as appeared, once", async () => {
    const events = createRuleEventRules({ rules: ruleSet });
    const before: RuleMatch[] = [];
    const after: RuleMatch[] = [{ agentKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" }), rule: triage!, issue: issue("BUTCHR-1") }];
    const snap = (ms: RuleMatch[]) => ({ primary: [] as ExecutionUnit<RuleMatch>[], related: scopeRelatedResources(ms) });
    const ev = await events.poll(snap(before), snap(after));
    expect(ev.changedRelated).toEqual(["jira-work:triage:BUTCHR-1"]);
    expect(await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related")).toEqual({ deliver: true, reason: { appeared: true } });
  });

  test("a status change in scope is delivered to the query agent, with its reason", async () => {
    const events = createRuleEventRules({ rules: ruleSet });
    const m = (over: Partial<JiraIssue> = {}): RuleMatch[] => [{ agentKey: "jira-work:triage:BUTCHR-1", rule: triage!, issue: issue("BUTCHR-1", over) }];
    const snap = (ms: RuleMatch[]) => ({ primary: [] as ExecutionUnit<RuleMatch>[], related: scopeRelatedResources(ms) });
    const ev = await events.poll(snap(m()), snap(m({ status: "In Review", updated: "later" })));
    expect(ev.changedRelated).toEqual(["jira-work:triage:BUTCHR-1"]);
    expect(await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
  });

  test("a comment is delivered to the query agent, named, via the same comments()-backed suppression stack a swarm agent uses", async () => {
    // The comment-cursor baseline is seeded from whichever comments() answer
    // a ticket's FIRST poll observes (KAN-828) — same discipline a swarm
    // agent's own delivery already depends on (test/unit/rule-engine.test.ts).
    // A warm-up poll with the OLD (empty) comment list seeds that baseline
    // before the real, NEW comment shows up on the second poll.
    let comments: Array<{ id: string; author: string; authorEmail: string; body: string; created: string; updated: string }> = [];
    const events = createRuleEventRules({ rules: ruleSet, comments: async () => comments });
    const m = (over: Partial<JiraIssue> = {}): RuleMatch[] => [{ agentKey: "jira-work:triage:BUTCHR-1", rule: triage!, issue: issue("BUTCHR-1", over) }];
    const snap = (ms: RuleMatch[]) => ({ primary: [] as ExecutionUnit<RuleMatch>[], related: scopeRelatedResources(ms) });
    await events.poll(snap(m()), snap(m())); // warm-up: seeds the baseline at "no comments yet"
    comments = [{ id: "c1", author: "u", authorEmail: "u@example.invalid", body: "hi", created: "t", updated: "t" }];
    // A daemon-label-shaped diff with no status/summary change is what routes through the comment-cursor check in this stack.
    const ev = await events.poll(snap(m()), snap(m({ labels: ["agent:working"], updated: "later" })));
    expect(ev.changedRelated).toEqual(["jira-work:triage:BUTCHR-1"]);
    const verdict = await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related");
    expect(verdict).toEqual({ deliver: true, reason: { comment: "c1" } });
  });

  test("dedup: two distinct tickets changing in the same poll are each delivered once to the query agent, never merged into one", async () => {
    const events = createRuleEventRules({ rules: ruleSet });
    const m = (a: Partial<JiraIssue>, b: Partial<JiraIssue>): RuleMatch[] => [
      { agentKey: "jira-work:triage:BUTCHR-1", rule: triage!, issue: issue("BUTCHR-1", a) },
      { agentKey: "jira-work:triage:BUTCHR-2", rule: triage!, issue: issue("BUTCHR-2", b) },
    ];
    const snap = (ms: RuleMatch[]) => ({ primary: [] as ExecutionUnit<RuleMatch>[], related: scopeRelatedResources(ms) });
    const ev = await events.poll(
      snap(m({}, {})),
      snap(m({ status: "In Review", updated: "later" }, { status: "Done", updated: "later" })),
    );
    expect([...ev.changedRelated].sort()).toEqual(["jira-work:triage:BUTCHR-1", "jira-work:triage:BUTCHR-2"]);
    expect(await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    expect(await ev.decide("jira-work:triage:BUTCHR-2", queryKey("triage"), "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "Done" } } });
  });

  test("own-write echo suppression is preserved for the query watcher, exactly as for a swarm agent", async () => {
    const ledger = createOwnWriteLedger();
    ledger.record("BUTCHR-1", "later", queryKey("triage"), Date.now());
    const events = createRuleEventRules({
      rules: ruleSet,
      suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()),
      comments: async () => [],
    });
    const m = (over: Partial<JiraIssue> = {}): RuleMatch[] => [{ agentKey: "jira-work:triage:BUTCHR-1", rule: triage!, issue: issue("BUTCHR-1", over) }];
    const snap = (ms: RuleMatch[]) => ({ primary: [] as ExecutionUnit<RuleMatch>[], related: scopeRelatedResources(ms) });
    const ev = await events.poll(snap(m()), snap(m({ labels: ["agent:working"], updated: "later" })));
    expect((await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related")).deliver).toBe(false);
  });

  test("swarm regression: mixing a swarm rule and a singleton rule in the same poll leaves the swarm rule's OWN primary-path routing untouched", async () => {
    const mixed = rules({ id: "task", query: "q1", execution: "swarm" }, { id: "triage", query: "q2", execution: "singleton" });
    const events = createRuleEventRules({ rules: mixed });
    const [task, tr] = mixed;
    const swarmM = (over: Partial<JiraIssue> = {}): RuleMatch => ({ agentKey: "jira-work:task:BUTCHR-9", rule: task!, issue: issue("BUTCHR-9", over) });
    const scopeM = (over: Partial<JiraIssue> = {}): RuleMatch => ({ agentKey: "jira-work:triage:BUTCHR-1", rule: tr!, issue: issue("BUTCHR-1", over) });
    const unit = (m: RuleMatch): ExecutionUnit<RuleMatch> => ({ kind: "resource", match: m });
    const snap = (swarm: RuleMatch, scope: RuleMatch) => ({ primary: [unit(swarm)], related: scopeRelatedResources([scope]) });
    const ev = await events.poll(
      snap(swarmM(), scopeM()),
      snap(swarmM({ status: "In Review", updated: "later" }), scopeM({ status: "Done", updated: "later" })),
    );
    expect(ev.changedPrimary).toEqual(["jira-work:task:BUTCHR-9"]);
    expect(ev.changedRelated).toEqual(["jira-work:triage:BUTCHR-1"]);
    expect(await ev.decide("jira-work:task:BUTCHR-9", "jira-work:task:BUTCHR-9", "primary")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    expect(await ev.decide("jira-work:triage:BUTCHR-1", queryKey("triage"), "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "Done" } } });
  });
});

describe("the resourceKeyOf hazard: a running query-level agent never causes a Jira/GitHub/Zendesk lookup keyed by its @query id (BUTCHR-398)", () => {
  test("resourceKeyOf on a query-level id never returns a real Jira/GitHub/Zendesk resource id", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "jira-idea", "zendesk-ticket"] as const) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      // decodeQueryAgentKey succeeds (it IS a query-level key) — decodeAgentKey (per-resource) never does.
      expect(decodeQueryAgentKey(key)).toEqual({ resourceProvider, ruleId: "triage" });
      // resourceKeyOf falls back to the WHOLE key for anything decodeAgentKey rejects — callers that
      // gate on this (daemon/index.ts's own isQueryLevelAgent) must check decodeQueryAgentKey FIRST,
      // never assume resourceKeyOf's fallback is a real ticket.
      expect(resourceKeyOf(key)).toBe(key);
      expect(resourceKeyOf(key)).not.toMatch(/^[A-Z][A-Z0-9]*-\d+$/); // never looks like a real Jira/idea key
    }
  });

  test("uniqueIssues never surfaces a query-level unit's bogus key as a ticket — only resource-kind matches are represented", () => {
    const r: Rule = { id: "triage", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "persistent", account: "none", role: "worker" };
    const units: ExecutionUnit<RuleMatch>[] = [
      { kind: "resource", match: { agentKey: "jira-work:triage:BUTCHR-1", rule: r, issue: issue("BUTCHR-1") } },
      { kind: "query", agentKey: queryKey("triage"), rule: r },
    ];
    expect(uniqueIssues(units).map((i) => i.key)).toEqual(["BUTCHR-1"]);
  });
});

describe("fleet capacity role: worker (default) | sentinel (BUTCHR-398)", () => {
  const roleOfFor = (rules: readonly Rule[]) => (id: string): AgentCapacityRole => {
    const decoded = decodeAnyAgentKey(id);
    if (!decoded) return "worker";
    const rule = rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
    return rule?.role ?? "worker";
  };

  test("an unflagged rule's agents behave identically to today: counted, withheld exactly as before", async () => {
    const worker: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker" };
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:task:A"], roleOf: roleOfFor([worker]) });
    expect(await ctrl.admit(["jira-work:task:B", "jira-work:task:C"], [])).toEqual([]); // both withheld, cap already full
    expect(ctrl.snapshot()).toMatchObject({ residency: 1, sentinels: 0 });
  });

  test("a sentinel is never withheld — admitted even at/over the cap, while workers around it are still rationed", async () => {
    const sentinel: Rule = { id: "director", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "persistent", account: "none", role: "sentinel" };
    const worker: Rule = { id: "task", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "swarm", account: "none", role: "worker" };
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:task:A"], roleOf: roleOfFor([sentinel, worker]) });
    const admitted = await ctrl.admit([queryKey("director"), "jira-work:task:B"], []);
    expect(admitted).toEqual([queryKey("director")]); // sentinel admitted; the worker candidate is withheld (cap already at 1 worker)
  });

  test("a sentinel never counts toward residency — adding sentinels changes nothing for workers' own budget", async () => {
    const sentinel: Rule = { id: "director", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "persistent", account: "none", role: "sentinel" };
    const ctrl = createAdmissionController({ cap: 2, residency: async () => [queryKey("director"), "jira-work:task:A"], roleOf: roleOfFor([sentinel]) });
    // cap=2, but only ONE resident WORKER (task:A) — the sentinel (director) must not consume the second slot.
    expect(await ctrl.admit(["jira-work:task:B"], [])).toEqual(["jira-work:task:B"]);
    expect(ctrl.snapshot()).toMatchObject({ residency: 1, sentinels: 1 });
  });

  test("sentinels start even when workers are withheld at the cap", async () => {
    const sentinel: Rule = { id: "director", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "persistent", account: "none", role: "sentinel" };
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:task:A"], roleOf: roleOfFor([sentinel]) });
    expect(await ctrl.admit(["jira-work:task:B", queryKey("director")], [])).toEqual([queryKey("director")]);
  });

  test("an id whose rule cannot be resolved (removed rule, legacy bare-issue agent) counts as a WORKER — fail-safe", async () => {
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["BUTCHR-1", "jira-work:gone:BUTCHR-2"], roleOf: roleOfFor([]) });
    expect(ctrl.snapshot()).toMatchObject({ residency: null, sentinels: null }); // no admit() yet
    await ctrl.admit([], []);
    expect(ctrl.snapshot()).toMatchObject({ residency: 2, sentinels: 0 }); // both unresolved ids counted as workers
  });

  test("omitted roleOf: every id is a worker — today's exact behaviour, unchanged", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => ["jira-work:task:A", queryKey("director")] });
    await ctrl.admit([], []);
    expect(ctrl.snapshot()).toMatchObject({ residency: 2, sentinels: 0 });
  });

  test("the [admission2] log line reports workers and sentinels separately", async () => {
    const sentinel: Rule = { id: "director", enabled: true, resourceProvider: "jira-work", query: "q", brief: "b", execution: "persistent", account: "none", role: "sentinel" };
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 5, residency: async () => [queryKey("director"), "jira-work:task:A"], roleOf: roleOfFor([sentinel]), log: (l) => lines.push(l) });
    await ctrl.admit(["jira-work:task:B"], []);
    const line = lines.find((l) => l.startsWith("[admission2]"))!;
    expect(line).toContain("residency(workers)=1 sentinels=1");
  });
});

describe("per-provider convergence and event delivery (BUTCHR-398 review finding 3): github-issue, zendesk-ticket, jira-idea", () => {
  const gi = (ref: string, over: Partial<GithubIssue> = {}): GithubIssue => {
    const r = parseGithubIssueRef(ref)!;
    return { ref, owner: r.owner, repo: r.repo, number: r.number, title: `title ${ref}`, body: "body", state: "open", stateReason: null, issueType: "Bug", labels: [], comments: 0, updated: "2026-09-16T00:00:00Z", url: `https://github.com/${r.owner}/${r.repo}/issues/${r.number}`, ...over };
  };
  const zt = (ref: string, over: Partial<ZendeskTicket> = {}): ZendeskTicket => {
    const r = parseZendeskTicketRef(ref)!;
    return { ref, id: r.id, subject: "s", description: "d", status: "open", priority: null, ticketType: "incident", tags: [], updated: "2026-09-16T10:00:00Z", url: "x", ...over };
  };
  const idea = (key: string, over: Partial<JiraIssue> = {}): JiraIssue =>
    ({ key, summary: key, status: "Discovery", issuetype: "Idea", assignee: null, parent: null, updated: "2026-09-16T00:00:00Z", labels: [], projectType: "product_discovery", ...over });

  /** One reconcile pass through a generic ResourceType, generic over `T` — mirrors jira-work's own `poll()` above. */
  async function pollType<T>(herd: Herd, type: ResourceType<T>): Promise<void> {
    const items = await type.discovery.search();
    await reconcileNow(herd, desiredFrom(items, type));
  }

  test("github-issue: singleton converges 0 -> 1 -> 0 -> 1, never a duplicate, restart adoption included", async () => {
    const ghRule = () => rules({ id: "bugs", resourceProvider: "github-issue", query: "is:open label:bug", execution: "singleton" })[0]!;
    let matched: GithubIssue[] = [];
    const herd = fakeHerd();
    const type = createGithubIssueResourceType({ rules: [ghRule()], search: async () => matched });
    await pollType(herd, type);
    expect(herd.spawned).toEqual([]); // N=0
    matched = [gi("acme/w#1"), gi("acme/w#2")];
    await pollType(herd, type);
    expect(herd.spawned).toEqual([queryKey2("github-issue", "bugs")]); // N>=1 -> exactly ONE
    matched = [];
    await pollType(herd, type);
    expect(herd.stopped).toEqual([queryKey2("github-issue", "bugs")]);
    matched = [gi("acme/w#3")];
    await pollType(herd, type);
    expect(herd.spawned).toEqual([queryKey2("github-issue", "bugs"), queryKey2("github-issue", "bugs")]); // spawned twice over its lifetime, never concurrently

    // Restart adoption: an already-running query agent is never re-spawned.
    const herd2 = fakeHerd([queryKey2("github-issue", "bugs")]);
    const type2 = createGithubIssueResourceType({ rules: [ghRule()], search: async () => [gi("acme/w#1")] });
    await pollType(herd2, type2);
    expect(herd2.spawned).toEqual([]);
  });

  test("github-issue: a state change in scope is delivered to the query agent once, deduplicated across two tickets", async () => {
    const [ghRule] = rules({ id: "bugs", resourceProvider: "github-issue", query: "is:open label:bug", execution: "singleton" });
    const events = createGithubIssueEventRules({});
    const m = (ref: string, over: Partial<GithubIssue> = {}): GithubIssueMatch => ({ agentKey: `github-issue:bugs:${encodeURIComponent(ref)}`, rule: ghRule!, issue: gi(ref, over) });
    const snap = (ms: GithubIssueMatch[]) => ({ primary: [] as ReturnType<typeof scopeRelatedResources<GithubIssueMatch>>[number]["issue"][], related: scopeRelatedResources(ms) });
    const ev = await events.poll(
      snap([m("acme/w#1"), m("acme/w#2")]),
      snap([m("acme/w#1", { state: "closed" }), m("acme/w#2", { title: "renamed" })]),
    );
    expect([...ev.changedRelated].sort()).toEqual(["github-issue:bugs:acme%2Fw%231", "github-issue:bugs:acme%2Fw%232"]);
    expect(await ev.decide("github-issue:bugs:acme%2Fw%231", queryKey2("github-issue", "bugs"), "related")).toEqual({ deliver: true, reason: { status: { from: "open", to: "closed" } } });
    expect(await ev.decide("github-issue:bugs:acme%2Fw%232", queryKey2("github-issue", "bugs"), "related")).toEqual({ deliver: true, reason: { summary: true } });
  });

  test("zendesk-ticket: persistent runs at N=0 and survives matches leaving; freeze (enabled:false) stops it", async () => {
    const zdRule = (enabled = true) => rules({ id: "support", resourceProvider: "zendesk-ticket", query: "status:open", execution: "persistent", enabled })[0]!;
    const herd = fakeHerd();
    const type = createZendeskTicketResourceType({ rules: [zdRule()], search: async () => [], comments: async () => [] });
    await pollType(herd, type);
    expect(herd.spawned).toEqual([queryKey2("zendesk-ticket", "support")]);
    const type2 = createZendeskTicketResourceType({ rules: [zdRule()], search: async () => [zt("acme#1")], comments: async () => [] });
    await pollType(herd, type2);
    expect(herd.spawned).toEqual([queryKey2("zendesk-ticket", "support")]); // still just the one
    expect(herd.stopped).toEqual([]);
    const off = createZendeskTicketResourceType({ rules: [zdRule(false)], search: async () => { throw new Error("a disabled rule must never be searched"); }, comments: async () => [] });
    await pollType(herd, off);
    expect(herd.stopped).toEqual([queryKey2("zendesk-ticket", "support")]);
  });

  test("zendesk-ticket: a status change in scope is delivered to the query agent, named", async () => {
    const [zdRule] = rules({ id: "support", resourceProvider: "zendesk-ticket", query: "status:open", execution: "singleton" });
    const events = createZendeskTicketEventRules({ comments: async () => [] });
    const m = (over: Partial<ZendeskTicket> = {}): ZendeskTicketMatch => ({ agentKey: "zendesk-ticket:support:acme%237", rule: zdRule!, ticket: zt("acme#7", over) });
    const snap = (ms: ZendeskTicketMatch[]) => ({ primary: [] as ReturnType<typeof scopeRelatedResources<ZendeskTicketMatch>>[number]["issue"][], related: scopeRelatedResources(ms) });
    const ev = await events.poll(snap([m()]), snap([m({ status: "pending", updated: "later" })]));
    expect(ev.changedRelated).toEqual(["zendesk-ticket:support:acme%237"]);
    expect(await ev.decide("zendesk-ticket:support:acme%237", queryKey2("zendesk-ticket", "support"), "related")).toEqual({ deliver: true, reason: { status: { from: "open", to: "pending" } } });
  });

  test("jira-idea: singleton converges 0 -> 1 -> 0, a proven idea only (non-idea work items excluded)", async () => {
    const ideaRule = () => rules({ id: "ideas", resourceProvider: "jira-idea", query: "project = IDEAS", execution: "singleton" })[0]!;
    let matched: JiraIssue[] = [issue("BUTCHR-1")]; // a work item, NOT a proven idea — must be excluded
    const herd = fakeHerd();
    const type = createJiraIdeaResourceType({ rules: [ideaRule()], search: async () => matched });
    await pollType(herd, type);
    expect(herd.spawned).toEqual([]); // the work item was excluded, so N=0
    matched = [idea("IDEA-1"), idea("IDEA-2")];
    await pollType(herd, type);
    expect(herd.spawned).toEqual([queryKey2("jira-idea", "ideas")]);
    matched = [];
    await pollType(herd, type);
    expect(herd.stopped).toEqual([queryKey2("jira-idea", "ideas")]);
  });

  test("jira-idea: a status change to one of its own scoped ideas is delivered to the query agent", async () => {
    const [ideaRule] = rules({ id: "ideas", resourceProvider: "jira-idea", query: "project = IDEAS", execution: "singleton" });
    let matched: JiraIssue[] = [idea("IDEA-1")];
    // `type` keeps its own internal `latest` state, advanced by each `search()`/`related()`
    // call in sequence — exactly the (search, related) pairing `runResourceLoop` itself performs
    // each poll — so driving ONE instance through two (search, related) rounds gives the real
    // (prev, next) snapshot pair the daemon would actually produce, no hand-assembly.
    const type = createJiraIdeaResourceType({ rules: [ideaRule!], search: async () => matched, comments: async () => [] });
    const before = await type.discovery.search();
    const relatedBefore = await type.discovery.related!([queryKey2("jira-idea", "ideas")]);
    matched = [idea("IDEA-1", { status: "Explore", updated: "later" })];
    const after = await type.discovery.search();
    const relatedAfter = await type.discovery.related!([queryKey2("jira-idea", "ideas")]);
    const ev = await type.eventRules.poll({ primary: before, related: relatedBefore }, { primary: after, related: relatedAfter });
    expect(ev.changedRelated).toEqual(["jira-idea:ideas:IDEA-1"]);
    expect(await ev.decide("jira-idea:ideas:IDEA-1", queryKey2("jira-idea", "ideas"), "related")).toEqual({ deliver: true, reason: { status: { from: "Discovery", to: "Explore" } } });
  });
});
