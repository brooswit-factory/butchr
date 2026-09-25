import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueLink, JiraIssue } from "../../src/atlassian/types.js";
import type { Herd } from "../../src/agents/herd.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import { spawnArgs, agentLaunchConfig } from "../../src/agents/argv.js";
import { agentIdOfWorkspacePath, briefFor, buildWorkspace, resourceKeyOf, workspaceDirFor } from "../../src/agents/workspace.js";
import { panesFor, groupOwnedPanes } from "../../src/agents/residency-census.js";
import { strandedCandidates } from "../../src/agents/reap.js";
import { desiredFrom, reconcileNow, runResourceLoop, scopedHerd } from "../../src/daemon/loop.js";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";
import { createOwnWriteLedger } from "../../src/jira-watch/own-writes.js";
import { EXECUTION_MODES, parseRules, type Rule } from "../../src/rules/rules.js";
import { createRuleEventRules, createRuleResourceType, FOREIGN_RULE_ID, foreignImplementerKeys, ownsRuleAgent, relatedForRules, searchRules, specForMatch, uniqueIssues, type RuleMatch } from "../../src/rules/resource-type.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue =>
  ({ key, status: "In Progress", summary: `summary of ${key}`, issuetype: "Task", assignee: "me", parent: null, updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over });

const rules = (...docs: object[]): Rule[] =>
  parseRules({ rules: docs.map((d) => ({ resourceProvider: "jira-work", brief: "do it", ...d })) });

// BUTCHR-398: `createRuleEventRules`/`createRuleResourceType` now operate over
// `ExecutionUnit<RuleMatch>` (swarm "resource"-kind primary/related units) —
// these tests exercise the swarm path exactly as before this ticket, so every
// fixture is wrapped at the boundary rather than changing what `matchesFor`/
// `match`/`relatedForRules` themselves produce (still plain `RuleMatch`).
const asUnit = (m: RuleMatch): ExecutionUnit<RuleMatch> => ({ kind: "resource", match: m });
const asRelatedUnits = (rs: readonly { issue: RuleMatch; watchers: readonly string[] }[]) =>
  rs.map((r) => ({ issue: asUnit(r.issue), watchers: r.watchers }));

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; specs: Map<string, unknown> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  const specs = new Map<string, unknown>();
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

/** One reconcile pass exactly as `runResourceLoop` performs it. */
async function poll(herd: Herd, ruleSet: Rule[], search: (jql: string) => Promise<JiraIssue[]>): Promise<ExecutionUnit<RuleMatch>[]> {
  const type = createRuleResourceType({ rules: ruleSet, search });
  const matches = await type.discovery.search();
  await reconcileNow(scopedHerd(herd, ownsRuleAgent), desiredFrom(matches, type));
  return matches;
}

describe("rule discovery", () => {
  test("zero rules, or only disabled rules, never searches and matches nothing", async () => {
    let calls = 0;
    const search = async () => { calls++; return [issue("BUTCHR-1")]; };
    expect(await searchRules({ rules: [], search })).toEqual([]);
    expect(await searchRules({ rules: rules({ id: "task", query: "q", enabled: false }), search })).toEqual([]);
    expect(calls).toBe(0);
  });

  test("each enabled rule runs its own JQL; one ticket matched by two rules is two agents", async () => {
    const seen: string[] = [];
    const matches = await searchRules({
      rules: rules({ id: "task", query: "type = Task" }, { id: "review", query: "status = Review" }, { id: "off", query: "never", enabled: false }),
      search: async (jql) => { seen.push(jql); return jql === "type = Task" ? [issue("BUTCHR-1"), issue("BUTCHR-2"), issue("BUTCHR-1")] : [issue("BUTCHR-1")]; },
    });
    expect(seen.sort()).toEqual(["status = Review", "type = Task"]);
    expect(matches.map((m) => m.agentKey)).toEqual(["jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-2", "jira-work:review:BUTCHR-1"]);
    expect(uniqueIssues(matches.map(asUnit)).map((i) => i.key)).toEqual(["BUTCHR-1", "BUTCHR-2"]);
  });

  test("one rule's failed search fails the whole poll rather than reading as zero matches", async () => {
    const search = async (jql: string) => { if (jql === "bad") throw new Error("400"); return [issue("BUTCHR-1")]; };
    await expect(searchRules({ rules: rules({ id: "ok", query: "good" }, { id: "broken", query: "bad" }), search })).rejects.toThrow("400");
  });

  test("the spawn spec carries the agent key as identity and the rule's brief and preferences", () => {
    const [rule] = rules({ id: "task", query: "q", agentPreferences: [{ harness: "codex", model: "gpt-5" }, { harness: "claude", effort: "max" }] });
    const spec = specForMatch({ agentKey: "jira-work:task:BUTCHR-7", rule: rule!, issue: issue("BUTCHR-7", { issuelinks: [{ type: "Implements", otherEnd: "inward", key: "BUTCHR-1" }] as never }) });
    expect(spec).toEqual({
      key: "jira-work:task:BUTCHR-7", resource: "BUTCHR-7", issuetype: "Task", summary: "summary of BUTCHR-7", parent: "BUTCHR-1",
      brief: "do it", agents: [{ harness: "codex", model: "gpt-5" }, { harness: "claude", effort: "max" }],
    });
  });
});

// BUTCHR-429 (epic BUTCHR-421, story 1/4): `createRuleResourceType`'s own
// wiring of link discovery + `[linked-discovery]` logging, over data
// `searchRules` already fetched (`issuelinks`/`parent`, part of
// `SEARCH_FIELDS`, src/atlassian/client.ts) — see `logLinkedDiscovery`'s own
// doc comment (src/rules/resource-type.ts).
describe("BUTCHR-429: linked-change discovery logging", () => {
  test("discovery.search() logs each match's discovered link set (issuelinks + parent, already-fetched data)", async () => {
    const lines: string[] = [];
    const withLinks = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      parent: "BUTCHR-421",
    });
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q" }), search: async () => [withLinks], log: (l) => lines.push(l) });
    await type.discovery.search();
    const linked = lines.filter((l) => l.startsWith("[linked-discovery]"));
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=issuelink target=BUTCHR-2 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=parent target=BUTCHR-421 skipped=false");
  });

  test("an unchanged link set across polls logs only once, not every poll", async () => {
    const lines: string[] = [];
    const withLinks = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q" }), search: async () => [withLinks], log: (l) => lines.push(l) });
    await type.discovery.search();
    await type.discovery.search();
    await type.discovery.search();
    expect(lines.filter((l) => l.startsWith("[linked-discovery]"))).toHaveLength(1);
  });

  test("a genuine change (a new link appears) logs again", async () => {
    const lines: string[] = [];
    let withImplements = false;
    const search = async () => [issue("BUTCHR-1", { issuelinks: (withImplements ? [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] : []) as never })];
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q" }), search, log: (l) => lines.push(l) });
    await type.discovery.search();
    expect(lines.filter((l) => l.startsWith("[linked-discovery]"))).toHaveLength(0); // no links yet -> nothing to log
    withImplements = true;
    await type.discovery.search();
    expect(lines.filter((l) => l.startsWith("[linked-discovery]"))).toEqual(["[linked-discovery] jira-work:task:BUTCHR-1 kind=issuelink target=BUTCHR-2 skipped=false"]);
  });

  test("rule.maxLinkedItems caps discovery AND logs the skipped extras — never a silent truncation", async () => {
    const lines: string[] = [];
    const withLinks = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" },
      ] as never,
    });
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q", maxLinkedItems: 1 }), search: async () => [withLinks], log: (l) => lines.push(l) });
    await type.discovery.search();
    const linked = lines.filter((l) => l.startsWith("[linked-discovery]"));
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=issuelink target=BUTCHR-2 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=issuelink target=BUTCHR-3 skipped=true");
  });

  test("with linkedEventing absent/false, discovery still runs and logs (cost-free), but adds ZERO new Jira calls beyond the rule's own JQL search — no fetch this story didn't already make", async () => {
    let searchCalls = 0;
    const withLinks = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      parent: "BUTCHR-421",
      description: "Also see https://example.com/docs and BUTCHR-1 itself.",
    });
    const lines: string[] = [];
    // linkedEventing is absent here — the whole point of this test.
    const type = createRuleResourceType({
      rules: rules({ id: "task", query: "q" }),
      search: async () => { searchCalls++; return [withLinks]; },
      log: (l) => lines.push(l),
    });
    await type.discovery.search();
    expect(searchCalls).toBe(1); // exactly the rule's own JQL search — the same count as before this story existed (description rides the same SEARCH_FIELDS payload, BUTCHR-431)
    expect(lines.some((l) => l.startsWith("[linked-discovery]"))).toBe(true); // discovery+logging ran anyway — it's a cost-free pure parse, not gated on linkedEventing
    expect(lines.some((l) => l.startsWith("[notify]"))).toBe(false); // and drove no notification — this story adds no eventing
  });

  // BUTCHR-431: `description` is now fed to discovery too — every kind
  // `descriptionItems` can produce shows up as its own `[linked-discovery]`
  // line, the match's own key is excluded, and `maxLinkedItems` still caps
  // (and logs skipped) across the combined issuelinks+parent+description set.
  test("a description containing a Confluence URL, a GitHub issue URL, a GitHub PR URL, a generic URL, and a bare Jira key produces a [linked-discovery] line per kind; the resource's own key is excluded", async () => {
    const lines: string[] = [];
    const withDescription = issue("BUTCHR-1", {
      description: [
        "Design: https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/1/Design",
        "Issue: https://github.com/brooswit-factory/butchr/issues/42",
        "PR: https://github.com/brooswit-factory/butchr/pull/395",
        "Docs: https://example.com/some/docs",
        "Also see BUTCHR-9 and, for context, this very ticket BUTCHR-1.",
      ].join(" "),
    });
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q" }), search: async () => [withDescription], log: (l) => lines.push(l) });
    await type.discovery.search();
    const linked = lines.filter((l) => l.startsWith("[linked-discovery]"));
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=confluence target=https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/1/Design skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=github-issue target=brooswit-factory/butchr#42 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=github-pr target=brooswit-factory/butchr#395 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=webpage target=https://example.com/some/docs skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=jira-key target=BUTCHR-9 skipped=false");
    expect(linked.some((l) => l.includes("target=BUTCHR-1 "))).toBe(false); // own key excluded, never reported as a link to itself
    expect(linked).toHaveLength(5);
  });

  test("maxLinkedItems still caps and logs skipped across the combined issuelinks+parent+description set", async () => {
    const lines: string[] = [];
    const withDescription = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      parent: "BUTCHR-421",
      description: "See BUTCHR-9 too.",
    });
    const type = createRuleResourceType({ rules: rules({ id: "task", query: "q", maxLinkedItems: 2 }), search: async () => [withDescription], log: (l) => lines.push(l) });
    await type.discovery.search();
    const linked = lines.filter((l) => l.startsWith("[linked-discovery]"));
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=issuelink target=BUTCHR-2 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=parent target=BUTCHR-421 skipped=false");
    expect(linked).toContain("[linked-discovery] jira-work:task:BUTCHR-1 kind=jira-key target=BUTCHR-9 skipped=true");
  });
});

describe("rule reconcile", () => {
  test("zero rules means zero staffing: every rule agent is stopped, nothing is spawned", async () => {
    const herd = fakeHerd(["jira-work:task:BUTCHR-1", "jira-work:review:BUTCHR-2"]);
    await poll(herd, [], async () => { throw new Error("must not search"); });
    expect(herd.spawned).toEqual([]);
    expect(herd.stopped.sort()).toEqual(["jira-work:review:BUTCHR-2", "jira-work:task:BUTCHR-1"]);
  });

  test("legacy agents are neither stopped nor adopted, even when a rule matches their ticket", async () => {
    const herd = fakeHerd(["BUTCHR-1", "BUTCHR"]);
    await poll(herd, rules({ id: "task", query: "q" }), async () => [issue("BUTCHR-1")]);
    expect(herd.stopped).toEqual([]);
    expect(herd.spawned).toEqual(["jira-work:task:BUTCHR-1"]);
    await poll(herd, [], async () => []);
    expect(herd.stopped).toEqual(["jira-work:task:BUTCHR-1"]);
  });

  test("an unchanged match across polls spawns once and never stops or respawns", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "task", query: "q" }, { id: "review", query: "q" });
    for (let i = 0; i < 3; i++) await poll(herd, ruleSet, async () => [issue("BUTCHR-1")]);
    expect(herd.spawned.sort()).toEqual(["jira-work:review:BUTCHR-1", "jira-work:task:BUTCHR-1"]);
    expect(herd.stopped).toEqual([]);
  });

  test("a ticket leaving one rule's query stops only that rule's agent", async () => {
    const herd = fakeHerd();
    const ruleSet = rules({ id: "task", query: "task" }, { id: "review", query: "review" });
    await poll(herd, ruleSet, async () => [issue("BUTCHR-1")]);
    await poll(herd, ruleSet, async (jql) => (jql === "task" ? [issue("BUTCHR-1")] : []));
    expect(herd.stopped).toEqual(["jira-work:review:BUTCHR-1"]);
  });
});

describe("rule event routing", () => {
  const snapshot = (primary: RuleMatch[]) => ({ primary: primary.map((m) => ({ kind: "resource" as const, match: m })), related: [] });
  const matchesFor = (ruleSet: Rule[], issues: JiraIssue[]) =>
    ruleSet.flatMap((rule) => issues.map((i) => ({ agentKey: `jira-work:${rule.id}:${i.key}`, rule, issue: i })));

  test("an unchanged match produces no event", async () => {
    const ruleSet = rules({ id: "task", query: "q" });
    const events = createRuleEventRules({ rules: ruleSet });
    const same = matchesFor(ruleSet, [issue("BUTCHR-1")]);
    expect((await events.poll(snapshot(same), snapshot(same))).changedPrimary).toEqual([]);
  });

  test("a change is delivered to every agent on the ticket, each under its own key", async () => {
    const ruleSet = rules({ id: "task", query: "q" }, { id: "review", query: "q" });
    const events = createRuleEventRules({ rules: ruleSet });
    const ev = await events.poll(snapshot(matchesFor(ruleSet, [issue("BUTCHR-1")])), snapshot(matchesFor(ruleSet, [issue("BUTCHR-1", { status: "In Review", updated: "later" })])));
    expect([...ev.changedPrimary].sort()).toEqual(["jira-work:review:BUTCHR-1", "jira-work:task:BUTCHR-1"]);
    for (const key of ev.changedPrimary) {
      expect(await ev.decide(key, key, "primary")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    }
    expect(await ev.decide("jira-work:task:BUTCHR-1", "jira-work:review:BUTCHR-1", "primary")).toEqual({ deliver: false });
    expect(await ev.decide("BUTCHR-1", "BUTCHR-1", "primary")).toEqual({ deliver: false });
  });

  test("one agent's own write is swallowed for that agent only, not for another agent on the same ticket", async () => {
    const ruleSet = rules({ id: "task", query: "q" }, { id: "review", query: "q" });
    const ledger = createOwnWriteLedger();
    ledger.record("BUTCHR-1", "later", "jira-work:task:BUTCHR-1", Date.now());
    const events = createRuleEventRules({ rules: ruleSet, suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()), comments: async () => [] });
    const ev = await events.poll(snapshot(matchesFor(ruleSet, [issue("BUTCHR-1")])), snapshot(matchesFor(ruleSet, [issue("BUTCHR-1", { status: "In Review", updated: "later" })])));
    expect((await ev.decide("jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-1", "primary")).deliver).toBe(false);
    expect((await ev.decide("jira-work:review:BUTCHR-1", "jira-work:review:BUTCHR-1", "primary")).deliver).toBe(true);
  });
});

describe("rule relationships", () => {
  // WORKER implements BOSS, seen from both ends exactly as Jira reports it.
  const implementsBoss = (boss: string): IssueLink[] => [{ type: "Implements", otherEnd: "inward", key: boss }];
  const implementedBy = (worker: string): IssueLink[] => [{ type: "Implements", otherEnd: "outward", key: worker }];
  // Relates is symmetric; `otherEnd` is only which side Jira stored the other ticket on.
  const relatesTo = (other: string, otherEnd: IssueLink["otherEnd"]): IssueLink[] => [{ type: "Relates", otherEnd, key: other }];
  const match = (rule: Rule, i: JiraIssue): RuleMatch => ({ agentKey: `jira-work:${rule.id}:${i.key}`, rule, issue: i });
  const byId = (ruleSet: Rule[], id: string) => ruleSet.find((r) => r.id === id)!;
  const keys = (ms: RuleMatch[]) => ms.map((m) => m.agentKey);

  // "epic" staffs bosses and hears "story" workers; "review" also matches the
  // boss ticket but declares no relationship; "audit" hears "story" as an
  // inward connection.
  const ruleSet = rules(
    { id: "epic", query: "q1", relationships: { childRule: "story" } },
    { id: "story", query: "q2" },
    { id: "review", query: "q3" },
    { id: "audit", query: "q4", relationships: { inwardConnectionRules: ["story"] } },
  );
  const boss = (over: Partial<JiraIssue> = {}) => issue("BUTCHR-1", { issuelinks: implementedBy("BUTCHR-2"), ...over });
  const worker = (over: Partial<JiraIssue> = {}) => issue("BUTCHR-2", { issuelinks: implementsBoss("BUTCHR-1"), ...over });
  const world = (w: JiraIssue, b: JiraIssue = boss()): RuleMatch[] => [
    match(byId(ruleSet, "epic"), b), match(byId(ruleSet, "review"), b),
    match(byId(ruleSet, "story"), w), match(byId(ruleSet, "review"), w),
  ];

  // BUTCHR-388: EVERY rule matching the boss ticket hears its implementer —
  // `Implements` routes on the link alone. The withdrawn guarantee (only the
  // rule declaring `childRule` heard) is asserted positively below rather
  // than deleted: `review` matches the boss ticket, declares no relationship,
  // and now hears. See this file's BUTCHR-388 describe block for why.
  test("every rule on the boss ticket hears its implementer, whether or not it declares a childRule", () => {
    const ms = world(worker());
    const [entry, ...rest] = relatedForRules(ruleSet, ms, keys(ms));
    expect(rest).toEqual([]); // one entry per heard TICKET, however many rules hear it
    expect(entry!.issue.issue.key).toBe("BUTCHR-2");
    expect(entry!.watchers).toEqual(["jira-work:epic:BUTCHR-1", "jira-work:review:BUTCHR-1"]);
  });

  test("the worker never watches its boss, and only active agents watch", () => {
    const ms = world(worker());
    expect(relatedForRules(ruleSet, ms, keys(ms)).flatMap((r) => r.watchers)).not.toContain("jira-work:story:BUTCHR-2");
    expect(relatedForRules(ruleSet, ms, keys(ms)).flatMap((r) => r.watchers)).not.toContain("jira-work:review:BUTCHR-2");
    // Only the boss ticket's agents watch, so dropping BOTH of them leaves nothing.
    const noBossAgents = keys(ms).filter((k) => !k.endsWith(":BUTCHR-1"));
    expect(relatedForRules(ruleSet, ms, noBossAgents)).toEqual([]);
  });

  test("an inward connection rule hears the connecting rule's ticket over Relates; the link is read from either end", () => {
    const w = issue("BUTCHR-2", { issuelinks: relatesTo("BUTCHR-1", "inward") });
    const ms = [match(byId(ruleSet, "audit"), issue("BUTCHR-1")), match(byId(ruleSet, "story"), w)];
    expect(relatedForRules(ruleSet, ms, keys(ms))).toEqual([{ issue: ms[1]!, watchers: ["jira-work:audit:BUTCHR-1"] }]);
    const fromListenerEnd = [match(byId(ruleSet, "audit"), issue("BUTCHR-1", { issuelinks: relatesTo("BUTCHR-2", "outward") })), match(byId(ruleSet, "story"), issue("BUTCHR-2"))];
    expect(relatedForRules(ruleSet, fromListenerEnd, keys(fromListenerEnd))[0]!.watchers).toEqual(["jira-work:audit:BUTCHR-1"]);
  });

  // BUTCHR-388: a boss hears what implements it, on the LINK alone. Before
  // this, an `Implements` edge also required the listener's rule to declare
  // `relationships.childRule` — a gate no rules file in the fleet declared
  // (so nothing was ever heard) and which cannot be satisfied across daemons
  // at all, since a rule id is per-file and the other daemon's ticket has no
  // local rule to name.
  describe("BUTCHR-388: Implements routes on the link, not on configuration", () => {
    // Deliberately declares NO relationships at all — the shape of every
    // live resource-rules.json on booswrit and wroosbit.
    const plain = rules({ id: "epics", query: "q1" }, { id: "tasks", query: "q2" });
    const bossIssue = issue("BUTCHR-1", { issuelinks: implementedBy("BUTCHR-2") });
    const workerIssue = issue("BUTCHR-2", { issuelinks: implementsBoss("BUTCHR-1") });

    test("a boss hears its implementer with no childRule declared anywhere", () => {
      const ms = [match(byId(plain, "epics"), bossIssue), match(byId(plain, "tasks"), workerIssue)];
      expect(relatedForRules(plain, ms, keys(ms))).toEqual([
        { issue: ms[1]!, watchers: ["jira-work:epics:BUTCHR-1"] },
      ]);
    });

    test("the implementer still never hears its boss", () => {
      const ms = [match(byId(plain, "epics"), bossIssue), match(byId(plain, "tasks"), workerIssue)];
      expect(relatedForRules(plain, ms, keys(ms)).flatMap((r) => r.watchers)).not.toContain("jira-work:tasks:BUTCHR-2");
    });

    test("a boss hears an implementer THIS daemon's rules do not match, supplied as foreign", () => {
      // The live shape: a Story on wroosbit whose Task only booswrit matches.
      const ms = [match(byId(plain, "epics"), bossIssue)];
      expect(relatedForRules(plain, ms, keys(ms))).toEqual([]); // nothing to hear without the fetch
      const heard = relatedForRules(plain, ms, keys(ms), [workerIssue]);
      expect(heard.map((r) => r.watchers)).toEqual([["jira-work:epics:BUTCHR-1"]]);
      expect(heard[0]!.issue.issue.key).toBe("BUTCHR-2");
      // Addressable, and never mistakable for a primary agent key.
      expect(heard[0]!.issue.agentKey).toBe("related:jira-work:BUTCHR-2");
      expect(heard[0]!.issue.rule.id).toBe(FOREIGN_RULE_ID);
    });

    test("Relates still routes only by configuration — an undeclared Relates hears nothing", () => {
      const a = issue("BUTCHR-1", { issuelinks: relatesTo("BUTCHR-2", "outward") });
      const b = issue("BUTCHR-2", { issuelinks: relatesTo("BUTCHR-1", "inward") });
      const ms = [match(byId(plain, "epics"), a), match(byId(plain, "tasks"), b)];
      expect(relatedForRules(plain, ms, keys(ms))).toEqual([]);
    });

    test("foreignImplementerKeys names the outward targets this daemon does not match, and only those", () => {
      const ms = [match(byId(plain, "epics"), bossIssue), match(byId(plain, "tasks"), workerIssue)];
      expect(foreignImplementerKeys(ms)).toEqual([]); // control: matched, so not foreign
      expect(foreignImplementerKeys([match(byId(plain, "epics"), bossIssue)])).toEqual(["BUTCHR-2"]);
    });
  });

  describe("sideways over Relates", () => {
    // "idea" accepts inward connections from "ticket"; "ticket" names nobody.
    const side = rules(
      { id: "idea", query: "q", relationships: { inwardConnectionRules: ["ticket"] } },
      { id: "ticket", query: "q" },
      { id: "triage", query: "q", relationships: { inwardConnectionRules: ["ticket"] } },
      { id: "other", query: "q" },
    );
    const r = (id: string) => byId(side, id);
    // The Relates link exactly as Jira reports it from BOTH tickets.
    const idea = (key = "BUTCHR-1", linked = "BUTCHR-2") => issue(key, { issuelinks: relatesTo(linked, "outward") });
    const ticket = (key = "BUTCHR-2", linked = "BUTCHR-1") => issue(key, { issuelinks: relatesTo(linked, "inward") });

    test("two-way link data, one-way communication: the listing rule hears, the listed rule does not", () => {
      const ms = [match(r("idea"), idea()), match(r("ticket"), ticket())];
      expect(relatedForRules(side, ms, keys(ms))).toEqual([{ issue: ms[1]!, watchers: ["jira-work:idea:BUTCHR-1"] }]);
      // Swapping which end is outward in Jira changes nothing: direction is configuration's.
      const swapped = [match(r("idea"), issue("BUTCHR-1", { issuelinks: relatesTo("BUTCHR-2", "inward") })), match(r("ticket"), issue("BUTCHR-2", { issuelinks: relatesTo("BUTCHR-1", "outward") }))];
      expect(relatedForRules(side, swapped, keys(swapped))).toEqual([{ issue: swapped[1]!, watchers: ["jira-work:idea:BUTCHR-1"] }]);
    });

    test("rules that name each other hear each other", () => {
      const mutual = rules(
        { id: "idea", query: "q", relationships: { inwardConnectionRules: ["ticket"] } },
        { id: "ticket", query: "q", relationships: { inwardConnectionRules: ["idea"] } },
      );
      const ms = [match(byId(mutual, "idea"), idea()), match(byId(mutual, "ticket"), ticket())];
      expect(relatedForRules(mutual, ms, keys(ms))).toEqual([
        { issue: ms[0]!, watchers: ["jira-work:ticket:BUTCHR-2"] },
        { issue: ms[1]!, watchers: ["jira-work:idea:BUTCHR-1"] },
      ]);
    });

    test("several listening rule agents each watch under their own key; a non-listening rule on the same ticket does not", () => {
      const ms = [
        match(r("idea"), idea()), match(r("triage"), idea()), match(r("other"), idea()),
        match(r("ticket"), ticket()),
      ];
      expect(relatedForRules(side, ms, keys(ms))).toEqual([
        { issue: ms[3]!, watchers: ["jira-work:idea:BUTCHR-1", "jira-work:triage:BUTCHR-1"] },
      ]);
      expect(relatedForRules(side, ms, keys(ms).filter((k) => k !== "jira-work:triage:BUTCHR-1"))[0]!.watchers).toEqual(["jira-work:idea:BUTCHR-1"]);
    });

    test("one heard ticket is one entry: several source rules, duplicate links, and several listening tickets all dedupe", () => {
      const twoSources = rules(
        { id: "idea", query: "q", relationships: { inwardConnectionRules: ["ticket", "bug"] } },
        { id: "ticket", query: "q" },
        { id: "bug", query: "q" },
      );
      // BUTCHR-2 relates to two ideas, and Jira shows the BUTCHR-1 link twice.
      const src = issue("BUTCHR-2", { issuelinks: [...relatesTo("BUTCHR-1", "inward"), ...relatesTo("BUTCHR-1", "inward"), ...relatesTo("BUTCHR-3", "outward")] });
      const ms = [
        match(byId(twoSources, "idea"), idea()), match(byId(twoSources, "idea"), issue("BUTCHR-3", { issuelinks: relatesTo("BUTCHR-2", "inward") })),
        match(byId(twoSources, "ticket"), src), match(byId(twoSources, "bug"), src),
      ];
      expect(relatedForRules(twoSources, ms, keys(ms))).toEqual([
        { issue: ms[3]!, watchers: ["jira-work:idea:BUTCHR-1", "jira-work:idea:BUTCHR-3"] },
      ]);
    });

    test("unrelated links route nothing sideways: Blocks, Implements for an inward rule, Relates for a child rule, links to unmatched tickets", () => {
      const withChild = rules(
        { id: "idea", query: "q", relationships: { inwardConnectionRules: ["ticket"] } },
        { id: "epic", query: "q", relationships: { childRule: "ticket" } },
        { id: "ticket", query: "q" },
      );
      const t = (id: string) => byId(withChild, id);
      const cases: RuleMatch[][] = [
        [match(t("idea"), issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] })), match(t("ticket"), issue("BUTCHR-2"))],
        [match(t("epic"), idea()), match(t("ticket"), ticket())],
        [match(t("idea"), idea("BUTCHR-1", "BUTCHR-99")), match(t("ticket"), ticket("BUTCHR-2", "BUTCHR-98"))],
      ];
      for (const ms of cases) expect(relatedForRules(withChild, ms, keys(ms))).toEqual([]);
    });

    // BUTCHR-388: the case removed from the list above, asserted positively
    // rather than deleted. `idea` declares only `inwardConnectionRules` and
    // no `childRule` — under link-only `Implements` routing it hears its
    // implementer anyway, because the LINK says it is the boss.
    test("an Implements link routes even when the listening rule declares only an inward connection", () => {
      const withChild = rules(
        { id: "idea", query: "q", relationships: { inwardConnectionRules: ["ticket"] } },
        { id: "ticket", query: "q" },
      );
      const t = (id: string) => byId(withChild, id);
      const ms = [match(t("idea"), boss()), match(t("ticket"), worker())];
      expect(relatedForRules(withChild, ms, keys(ms))).toEqual([
        { issue: ms[1]!, watchers: ["jira-work:idea:BUTCHR-1"] },
      ]);
    });

    test("a Relates change notifies the listening agent once through event routing, and not the listed one", async () => {
      const events = createRuleEventRules({ rules: side });
      const snap = (ms: RuleMatch[]) => ({ primary: ms.map(asUnit), related: asRelatedUnits(relatedForRules(side, ms, keys(ms))) });
      const at = (t: JiraIssue, i: JiraIssue = idea()) => [match(r("idea"), i), match(r("ticket"), t)];
      const ev = await events.poll(snap(at(ticket())), snap(at(issue("BUTCHR-2", { issuelinks: relatesTo("BUTCHR-1", "inward"), status: "Done", updated: "later" }))));
      expect(ev.changedRelated).toEqual(["jira-work:ticket:BUTCHR-2"]);
      expect((await ev.decide("jira-work:ticket:BUTCHR-2", "jira-work:idea:BUTCHR-1", "related")).deliver).toBe(true);
      expect(await ev.decide("jira-work:ticket:BUTCHR-2", "jira-work:ticket:BUTCHR-2", "related")).toEqual({ deliver: false });
      // The idea changing is heard by nobody else: the ticket rule does not accept it inward.
      const back = await events.poll(snap(at(ticket())), snap(at(ticket(), issue("BUTCHR-1", { issuelinks: relatesTo("BUTCHR-2", "outward"), status: "Done", updated: "later" }))));
      expect(back.changedRelated).toEqual([]);
    });
  });

  test("a missing or invalid relationship routes nothing, without disturbing a valid one", () => {
    const epic = byId(ruleSet, "epic"), story = byId(ruleSet, "story"), review = byId(ruleSet, "review");
    const cases: Array<[string, RuleMatch[]]> = [
      ["no link", [match(epic, issue("BUTCHR-1")), match(story, issue("BUTCHR-2"))]],
      ["a Relates link", [match(epic, issue("BUTCHR-1", { issuelinks: [{ type: "Relates", otherEnd: "outward", key: "BUTCHR-2" }] })), match(story, issue("BUTCHR-2"))]],
      ["a link to a ticket no rule matches and nothing was fetched for", [match(epic, issue("BUTCHR-1", { issuelinks: implementedBy("BUTCHR-99") })), match(story, issue("BUTCHR-2", { issuelinks: implementsBoss("BUTCHR-98") }))]],
    ];
    for (const [, ms] of cases) expect(relatedForRules(ruleSet, ms, keys(ms))).toEqual([]);

    // BUTCHR-388: two cases moved out of the list above, asserted positively
    // rather than deleted, because link-only routing now covers them.
    // (a) A "reversed" Implements link is not invalid — it names the OTHER
    //     ticket as the boss, so that ticket's agents hear. Direction still
    //     decides who listens; only the rule gate is gone.
    const reversed = [match(epic, issue("BUTCHR-1", { issuelinks: implementsBoss("BUTCHR-2") })), match(story, issue("BUTCHR-2", { issuelinks: implementedBy("BUTCHR-1") }))];
    expect(relatedForRules(ruleSet, reversed, keys(reversed))).toEqual([
      { issue: reversed[0]!, watchers: ["jira-work:story:BUTCHR-2"] },
    ]);
    // (b) THE WITHDRAWN GUARANTEE, stated: a worker matched only by a rule
    //     the boss's rule never named is heard anyway. Before BUTCHR-388 this
    //     routed nothing; that gate was dead in production (no rules file
    //     declares `childRule`) and unsatisfiable across daemons.
    const unnamed = [match(epic, boss()), match(review, worker())];
    expect(relatedForRules(ruleSet, unnamed, keys(unnamed))).toEqual([
      { issue: unnamed[1]!, watchers: ["jira-work:epic:BUTCHR-1"] },
    ]);

    // BUTCHR-388: two implementers of one boss — one matched by the rule the
    // boss's rule used to name, one matched only by `review`. Both are heard
    // now, one entry each. Before, the second routed nothing; that is the
    // withdrawn guarantee again, in the multi-link shape.
    const mixed = [
      match(epic, issue("BUTCHR-1", { issuelinks: [...implementedBy("BUTCHR-2"), ...implementedBy("BUTCHR-3")] })),
      match(story, worker()),
      match(review, issue("BUTCHR-3", { issuelinks: implementsBoss("BUTCHR-1") })),
    ];
    expect(relatedForRules(ruleSet, mixed, keys(mixed)).map((r) => [r.issue.issue.key, r.watchers])).toEqual([
      ["BUTCHR-2", ["jira-work:epic:BUTCHR-1"]],
      ["BUTCHR-3", ["jira-work:epic:BUTCHR-1"]],
    ]);
  });

  test("a worker matched by several rules is one entry; a child rule and an inward rule on one ticket each watch under their own key", () => {
    const two = rules(
      { id: "epic", query: "q", relationships: { childRule: "story" } },
      { id: "lead", query: "q", relationships: { inwardConnectionRules: ["story", "spike"] } },
      { id: "story", query: "q" },
      { id: "spike", query: "q" },
    );
    // The tickets are joined both ways: Implements (for epic) and Relates (for lead).
    const b = boss({ issuelinks: [...implementedBy("BUTCHR-2"), ...relatesTo("BUTCHR-2", "outward")] });
    const w = worker({ issuelinks: [...implementsBoss("BUTCHR-1"), ...relatesTo("BUTCHR-1", "inward")] });
    const ms = [
      match(byId(two, "epic"), b), match(byId(two, "lead"), b),
      match(byId(two, "story"), w), match(byId(two, "spike"), w),
    ];
    expect(relatedForRules(two, ms, keys(ms))).toEqual([
      { issue: ms[3]!, watchers: ["jira-work:epic:BUTCHR-1", "jira-work:lead:BUTCHR-1"] },
    ]);
  });

  // BUTCHR-388: a related entry is addressed by ONE id even when several
  // rules match the heard ticket, and which one is an arbitrary tiebreak
  // (smallest agent key — here `review` sorts before `story`). These tests
  // derive it rather than hardcoding it, so they assert the behaviour that
  // matters (the boss hears, once) and not the tiebreak, which is tracked
  // separately and may change.
  const relatedIdFor = (ms: RuleMatch[], issueKey: string) =>
    relatedForRules(ruleSet, ms, keys(ms)).find((r) => r.issue.issue.key === issueKey)!.issue.agentKey;

  test("the boss learns a child's status change, once, and no other agent does", async () => {
    const events = createRuleEventRules({ rules: ruleSet });
    const snap = (ms: RuleMatch[]) => ({ primary: ms.map(asUnit), related: asRelatedUnits(relatedForRules(ruleSet, ms, keys(ms))) });
    const before = world(worker()), after = world(worker({ status: "In Review", updated: "later" }));
    const heard = relatedIdFor(after, "BUTCHR-2");
    const ev = await events.poll(snap(before), snap(after));
    expect(ev.changedRelated).toEqual([heard]);
    expect(await ev.decide(heard, "jira-work:epic:BUTCHR-1", "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    // Every rule on the boss ticket hears it; no agent on the WORKER ticket does.
    expect(await ev.decide(heard, "jira-work:review:BUTCHR-1", "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    for (const other of ["jira-work:story:BUTCHR-2", "jira-work:review:BUTCHR-2", "jira-work:audit:BUTCHR-1"]) {
      expect(await ev.decide(heard, other, "related")).toEqual({ deliver: false });
    }
    // The worker's own agents still hear it on the primary path, each under its own key.
    expect([...ev.changedPrimary].sort()).toEqual(["jira-work:review:BUTCHR-2", "jira-work:story:BUTCHR-2"]);
  });

  test("a worker agent's own write is swallowed for itself but still reaches its boss", async () => {
    const ledger = createOwnWriteLedger();
    ledger.record("BUTCHR-2", "later", "jira-work:story:BUTCHR-2", Date.now());
    const events = createRuleEventRules({ rules: ruleSet, suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()), comments: async () => [] });
    const snap = (ms: RuleMatch[]) => ({ primary: ms.map(asUnit), related: asRelatedUnits(relatedForRules(ruleSet, ms, keys(ms))) });
    const after = world(worker({ status: "In Review", updated: "later" }));
    const heard = relatedIdFor(after, "BUTCHR-2");
    const ev = await events.poll(snap(world(worker())), snap(after));
    expect((await ev.decide("jira-work:story:BUTCHR-2", "jira-work:story:BUTCHR-2", "primary")).deliver).toBe(false);
    expect((await ev.decide(heard, "jira-work:epic:BUTCHR-1", "related")).deliver).toBe(true);
  });

  test("through the loop: a child status change notifies the boss agent exactly once and no unrelated agent", async () => {
    const store = { worker: worker() };
    const jql: Record<string, () => JiraIssue[]> = { q1: () => [boss()], q2: () => [store.worker], q3: () => [boss(), store.worker], q4: () => [] };
    const type = createRuleResourceType({ rules: ruleSet, search: async (q) => jql[q]!() });
    const notified: string[] = [];
    const stop = runResourceLoop(type, { herd: fakeHerd(), ownsId: ownsRuleAgent, notify: async (agent, about) => { notified.push(`${agent} <- ${about}`); }, intervalMs: 15 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(notified).toEqual([]);
      store.worker = worker({ status: "In Review", updated: "later" });
      await new Promise((r) => setTimeout(r, 80));
    } finally { stop(); }
    // BUTCHR-388: the boss hears exactly once. The id it hears the child
    // UNDER is the arbitrary smallest-key tiebreak, so match on the ticket
    // rather than on which rule won it.
    expect(notified.filter((n) => n.startsWith("jira-work:epic:"))).toEqual([
      expect.stringMatching(/^jira-work:epic:BUTCHR-1 <- jira-work:(story|review):BUTCHR-2$/) as unknown as string,
    ]);
    // `review` also matches the boss ticket, so under link-only routing it
    // hears too — the withdrawn guarantee, asserted rather than assumed.
    expect(notified.filter((n) => n.startsWith("jira-work:review:BUTCHR-1 <-"))).toHaveLength(1);
    expect(notified.filter((n) => n.startsWith("jira-work:story:BUTCHR-2") || n.startsWith("jira-work:review:BUTCHR-2")).sort())
      .toEqual(["jira-work:review:BUTCHR-2 <- jira-work:review:BUTCHR-2", "jira-work:story:BUTCHR-2 <- jira-work:story:BUTCHR-2"]);
  });
});

// BUTCHR-406 — SCOPE NOTE: the epic (BUTCHR-365, comment 23746 on BUTCHR-402)
// decided the PR into BUTCHR-402 should be a REGRESSION TEST ONLY, proving
// the cross-daemon boss wake already works on main's existing mechanism (PR
// #372, BUTCHR-388) once combined with BUTCHR-397/398's execution modes — no
// staffed:false observer rule involved; that code stays parked on
// origin/BUTCHR-402-observer-parked. This describe block is that test.
describe("BUTCHR-406: cross-daemon boss wake regression (two disjoint daemon views, BUTCHR-388 x execution modes)", () => {
  // The exact incident shape (BUTCHR-392/398): daemon A's rules match the
  // CHILD (a Task) and daemon B's rules match the BOSS (a Story) — neither
  // daemon's rules match the other's ticket, so the only thing that can wake
  // the boss on B is #372's by-key foreign fetch (`foreignImplementerKeys` +
  // `key in (...)`), read through the REAL discovery.related() and the real
  // loop's own change detection (runResourceLoop) — not relatedForRules
  // called directly as a unit, which every other test in this file does.
  const childKey = "BUTCHR-398", bossKey = "BUTCHR-392";
  const childIssue = (over: Partial<JiraIssue> = {}): JiraIssue =>
    issue(childKey, { issuetype: "Task", issuelinks: [{ type: "Implements", otherEnd: "inward", key: bossKey }], ...over });
  const bossIssue: JiraIssue = issue(bossKey, { issuetype: "Story", issuelinks: [{ type: "Implements", otherEnd: "outward", key: childKey }] });

  /**
   * Runs daemon A (staffs the child) and daemon B (staffs the boss, and ONLY
   * the boss — its own search never returns the child) against a single
   * shared mutable "Jira" (`world.child`), each through its own real
   * `runResourceLoop`, across one polling window before and after the child
   * changes. `bossExecution` is `undefined` for "no execution field declared
   * at all" (the plain, pre-BUTCHR-397 shape) and one of `EXECUTION_MODES`
   * otherwise — only the BOSS's rule varies; the child-side daemon is
   * ordinary swarm throughout, since this test is about whether the BOSS
   * hears, not how the child itself runs.
   */
  async function runTwoDaemons(bossExecution?: Rule["execution"]) {
    const world = { child: childIssue() };
    const rulesA = rules({ id: "task", query: "qa" });
    const herdA = fakeHerd();
    const typeA = createRuleResourceType({ rules: rulesA, search: async (jql) => (jql === "qa" ? [world.child] : []) });

    const rulesB = parseRules({ rules: [{
      id: "story", resourceProvider: "jira-work", query: "qb", brief: "hear your implementer",
      ...(bossExecution ? { execution: bossExecution } : {}),
    }] });
    const herdB = fakeHerd();
    const notifiedB: string[] = [];
    const searchB = async (jql: string): Promise<JiraIssue[]> => {
      if (jql === "qb") return [bossIssue];
      // The cross-daemon by-key fetch (#372): the ONLY way daemon B can ever
      // see the child, since daemon B's own rules never match it.
      if (jql.startsWith("key in (")) return jql.includes(childKey) ? [world.child] : [];
      return [];
    };
    const typeB = createRuleResourceType({ rules: rulesB, search: searchB });

    const stopA = runResourceLoop(typeA, { herd: herdA, ownsId: ownsRuleAgent, notify: async () => {}, intervalMs: 15 });
    const stopB = runResourceLoop(typeB, { herd: herdB, ownsId: ownsRuleAgent, notify: async (agent, about) => { notifiedB.push(`${agent} <- ${about}`); }, intervalMs: 15 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(notifiedB).toEqual([]); // nothing changed yet
      // Daemon A's worker's report_to_boss/submit_to_boss: the child ticket changes.
      world.child = childIssue({ status: "In Review", updated: "later" });
      await new Promise((r) => setTimeout(r, 80));
    } finally { stopA(); stopB(); }
    return { notifiedB, herdA, herdB };
  }

  for (const bossExecution of [undefined, ...EXECUTION_MODES]) {
    const label = bossExecution ?? "undeclared (defaults to swarm)";
    test(`the boss on daemon B is woken by the child's change on daemon A, with no agent spawned for the child on B — boss rule execution=${label}`, async () => {
      const { notifiedB, herdB } = await runTwoDaemons(bossExecution);
      // Exactly one notify for the child's change — not merely "at least
      // one" — so a double-delivery (e.g. the by-key Implements edge and
      // `scopeRelatedResources` both addressing the same query-level agent)
      // would fail this test even though `.some(...)` alone would not.
      expect(notifiedB.filter((n) => n.includes(childKey))).toHaveLength(1);
      // No agent is ever spawned for the child on daemon B — its own rules
      // never match the child, in every execution mode. (A singleton/
      // persistent boss's OWN spawned key is the query-level marker, e.g.
      // "jira-work:story:%40query" — it contains neither the boss's nor the
      // child's ticket key, so this only asserts the child never appears,
      // not that every spawned key names the boss.)
      expect(herdB.spawned.some((k) => k.includes(childKey))).toBe(false);
      expect(herdB.spawned.length).toBeGreaterThan(0);
    });
  }
});

// BUTCHR-416 — SCOPE NOTE (BUTCHR-402 comments 23851/23855): BUTCHR-406 above
// proves the generic direction (two disjoint daemon views over one linked
// pair) but does not shape either daemon's rules/search by ISSUE TYPE and
// does not cover Story -> Epic. This block extends the same harness — real
// `createRuleResourceType` + `runResourceLoop`, no unit called directly — so
// each simulated daemon's rule and search are shaped like the real fleet
// split: a wroosbit-like rule matches only Story/Sub-task, a booswrit-like
// rule matches only Epic/Task/Bug. These queries are REPRESENTATIVE, not
// read from or copied out of any live rules file (forbidden for this task —
// see brief.md); "issuetype = X" is a generic JQL shape, not live content.
// NO observer rules and no `staffed:false` anywhere below: every match here
// is an ordinary staffed rule match, and the only mechanism under test is
// main's existing #372 by-key foreign fetch (`foreignImplementerKeys`) plus
// the BUTCHR-406 live-key fix — both already on main, unmodified by this PR.
describe("BUTCHR-416: cross-daemon upward wake under the real issue-type split (no observer rules)", () => {
  type SplitType = "Epic" | "Task" | "Bug" | "Story" | "Sub-task";
  // The split itself, stated once. Matches the ticket's own example
  // (booswrit: Epic/Task/Bug; wroosbit: Story/Sub-task) — verified against no
  // live file, per the scope note above.
  const daemonFor = (t: SplitType): "wroosbit" | "booswrit" => (t === "Story" || t === "Sub-task" ? "wroosbit" : "booswrit");
  // One representative rule per issue type, each with its own rule id — so
  // an execution mode set on one type's rule never entangles another type's
  // rule, even when both are staffed by the same daemon (Story/Sub-task).
  const RULE_FOR: Record<SplitType, { id: string; query: string }> = {
    Epic: { id: "epics", query: "issuetype = Epic" },
    Task: { id: "tasks", query: "issuetype = Task" },
    Bug: { id: "bugs", query: "issuetype = Bug" },
    Story: { id: "story", query: "issuetype = Story" },
    "Sub-task": { id: "subtask", query: "issuetype = Sub-task" },
  };
  const agentKeyOf = (t: SplitType, key: string) => `jira-work:${RULE_FOR[t].id}:${key}`;

  const ruleDoc = (t: SplitType, execution?: Rule["execution"]) => ({
    ...RULE_FOR[t], resourceProvider: "jira-work" as const, brief: "hear your implementer",
    ...(execution ? { execution } : {}),
  });

  /** This daemon's simulated JQL: each rule's own query returns only its own type; a by-key fetch (#372) returns any ticket by key, exactly as a real Jira credential would (key lookup is not type-scoped). */
  const searchOver = (world: () => JiraIssue[]) => async (jql: string): Promise<JiraIssue[]> => {
    if (jql.startsWith("key in (")) return world().filter((i) => jql.includes(i.key));
    const type = (Object.keys(RULE_FOR) as SplitType[]).find((t) => RULE_FOR[t].query === jql);
    return type ? world().filter((i) => i.issuetype === type) : [];
  };

  const childOf = (childKey: string, childType: SplitType, bossKey: string) => (over: Partial<JiraIssue> = {}): JiraIssue =>
    issue(childKey, { issuetype: childType, issuelinks: [{ type: "Implements", otherEnd: "inward", key: bossKey }], ...over });
  const bossOf = (bossKey: string, bossType: SplitType, childKey: string): JiraIssue =>
    issue(bossKey, { issuetype: bossType, issuelinks: [{ type: "Implements", otherEnd: "outward", key: childKey }] });

  /**
   * Two REAL daemons — one rule each, shaped by issue type — each run
   * through its own real `runResourceLoop`, against a single shared mutable
   * "Jira". Only valid for a pair that IS cross-daemon under `daemonFor`;
   * asserts that itself so a future direction can't silently reuse this
   * harness for a same-daemon pair (see the Sub-task -> Story block below,
   * which deliberately does NOT use this harness).
   */
  async function runCrossDaemon(childKey: string, childType: SplitType, bossKey: string, bossType: SplitType, bossExecution?: Rule["execution"]) {
    expect(daemonFor(childType)).not.toBe(daemonFor(bossType)); // this harness is for genuinely cross-daemon pairs only
    const makeChild = childOf(childKey, childType, bossKey);
    const boss = bossOf(bossKey, bossType, childKey);
    const world = { child: makeChild() };
    const tickets = () => [world.child, boss];

    const herdChild = fakeHerd();
    const notifiedChild: string[] = [];
    const typeChild = createRuleResourceType({ rules: parseRules({ rules: [ruleDoc(childType)] }), search: searchOver(tickets) });

    const herdBoss = fakeHerd();
    const notifiedBoss: string[] = [];
    const typeBoss = createRuleResourceType({ rules: parseRules({ rules: [ruleDoc(bossType, bossExecution)] }), search: searchOver(tickets) });

    const stopChild = runResourceLoop(typeChild, { herd: herdChild, ownsId: ownsRuleAgent, notify: async (a, b) => { notifiedChild.push(`${a} <- ${b}`); }, intervalMs: 15 });
    const stopBoss = runResourceLoop(typeBoss, { herd: herdBoss, ownsId: ownsRuleAgent, notify: async (a, b) => { notifiedBoss.push(`${a} <- ${b}`); }, intervalMs: 15 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(notifiedBoss).toEqual([]); // (4) nothing changed yet: no spurious notify
      expect(notifiedChild).toEqual([]);
      // The child worker's own report_to_boss/submit_to_boss: the child ticket changes.
      world.child = makeChild({ status: "In Review", updated: "later" });
      await new Promise((r) => setTimeout(r, 80));
    } finally { stopChild(); stopBoss(); }
    return { notifiedBoss, notifiedChild, herdBoss, herdChild };
  }

  const CROSS_DAEMON_DIRECTIONS: Array<{ label: string; childType: SplitType; bossType: SplitType; childKey: string; bossKey: string }> = [
    // The exact incident shape named in BUTCHR-402's description (BUTCHR-398 implements BUTCHR-392).
    { label: "Task -> Story", childType: "Task", bossType: "Story", childKey: "BUTCHR-398", bossKey: "BUTCHR-392" },
    // The boss is now on the OTHER daemon (booswrit) than in Task -> Story above — a
    // genuinely different direction, not a relabelling. Reuses this fleet's own real
    // pair (BUTCHR-402 Implements BUTCHR-365 — verified live via jira_get_issue).
    { label: "Story -> Epic", childType: "Story", bossType: "Epic", childKey: "BUTCHR-402", bossKey: "BUTCHR-365" },
  ];

  for (const { label, childType, bossType, childKey, bossKey } of CROSS_DAEMON_DIRECTIONS) {
    describe(`${label} (cross-daemon: ${daemonFor(childType)} child, ${daemonFor(bossType)} boss)`, () => {
      for (const bossExecution of [undefined, ...EXECUTION_MODES]) {
        const execLabel = bossExecution ?? "undeclared (defaults to swarm)";
        test(`the boss is woken by the child's change exactly once, no agent spawns for the child on the boss's daemon, and the child never hears about its boss — boss execution=${execLabel}`, async () => {
          const { notifiedBoss, notifiedChild, herdBoss } = await runCrossDaemon(childKey, childType, bossKey, bossType, bossExecution);
          // (1) exactly one notify to the boss for the child's change — not "at least
          // one", so a double-delivery would fail this even though `.some()` would not.
          expect(notifiedBoss.filter((n) => n.includes(childKey))).toHaveLength(1);
          // (2) no agent is ever spawned for the foreign child on the boss's own daemon.
          expect(herdBoss.spawned.some((k) => k.includes(childKey))).toBe(false);
          expect(herdBoss.spawned.length).toBeGreaterThan(0); // the boss's own agent DID spawn
          // (3) the implementer (child) never hears about its boss — routes.ts (and
          // `relatedForRules`'s `implementsEdge`) route only boss-hears-child, never back.
          expect(notifiedChild.some((n) => n.includes(bossKey))).toBe(false);
        });
      }
    });
  }

  // Per the ticket: "check whether that pair is even cross-daemon" for
  // Sub-task -> Story. Under `daemonFor` above, both are wroosbit — SAME
  // daemon, not cross-daemon — so this proves the same-daemon wake instead,
  // and proves the "same-daemon" claim directly rather than asserting it:
  // no `key in (...)` (the cross-daemon-only foreign fetch) is ever issued
  // for this pair. Synthetic keys (no real fleet incident named this pair).
  describe("Sub-task -> Story: NOT cross-daemon under the real split (both staffed by wroosbit)", () => {
    const childKey = "BUTCHR-500", bossKey = "BUTCHR-501";
    const makeChild = childOf(childKey, "Sub-task", bossKey);
    const boss = bossOf(bossKey, "Story", childKey);

    for (const bossExecution of [undefined, "singleton"] as const) {
      const execLabel = bossExecution ?? "undeclared (defaults to swarm)";
      test(`the Story boss is woken by the Sub-task child's change on the SAME daemon, exactly once, with no cross-daemon fetch — boss execution=${execLabel}`, async () => {
        const world = { child: makeChild() };
        let sawKeyInFetch = false;
        const search = async (jql: string): Promise<JiraIssue[]> => {
          if (jql.startsWith("key in (")) { sawKeyInFetch = true; return [world.child, boss].filter((i) => jql.includes(i.key)); }
          return searchOver(() => [world.child, boss])(jql);
        };
        const herd = fakeHerd();
        const notified: string[] = [];
        // TWO rules, one per type (as on the real wroosbit daemon) — only the
        // "story" rule (the boss's) varies execution; "subtask" stays swarm.
        const rules = parseRules({ rules: [ruleDoc("Sub-task"), ruleDoc("Story", bossExecution)] });
        const type = createRuleResourceType({ rules, search });
        const stop = runResourceLoop(type, { herd, ownsId: ownsRuleAgent, notify: async (a, b) => { notified.push(`${a} <- ${b}`); }, intervalMs: 15 });
        try {
          await new Promise((r) => setTimeout(r, 60));
          expect(notified).toEqual([]); // (4) nothing changed yet: no spurious notify
          world.child = makeChild({ status: "In Review", updated: "later" });
          await new Promise((r) => setTimeout(r, 80));
        } finally { stop(); }
        // The child's own primary self-notify (its own agent hearing its own
        // status change) also mentions childKey — exclude it by its exact,
        // known shape so the assertion below isolates the BOSS's notify only.
        const childSelfNotify = `${agentKeyOf("Sub-task", childKey)} <- ${agentKeyOf("Sub-task", childKey)}`;
        const toBoss = notified.filter((n) => n.includes(childKey) && n !== childSelfNotify);
        // (1) exactly one notify to the boss for the child's change.
        expect(toBoss).toHaveLength(1);
        // (3) the child (implementer) never hears about its boss — no notify
        // line where the child's own agent is the LISTENER and the boss is
        // (part of) the source.
        expect(notified.some((n) => n.startsWith(`${agentKeyOf("Sub-task", childKey)} <-`) && n.includes(bossKey))).toBe(false);
        // Proves "same daemon" rather than asserting it: the boss heard its
        // implementer through this daemon's OWN search results alone — #372's
        // cross-daemon by-key fetch was never exercised for this pair.
        expect(sawKeyInFetch).toBe(false);
      });
    }
  });
});

describe("rule workspaces", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.BUTCHR_WORKSPACES;
    root = mkdtempSync(join(tmpdir(), "butchr-rule-ws-"));
    process.env.BUTCHR_WORKSPACES = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
    else process.env.BUTCHR_WORKSPACES = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const ruleSpec = { key: "jira-work:task:BUTCHR-12", resource: "BUTCHR-12", issuetype: "Task", summary: "fix it", parent: null, brief: "Rule brief body." };

  test("an agent key maps to a nested path and back; legacy and foreign paths do not decode as rule agents", () => {
    expect(workspaceDirFor("jira-work:task:BUTCHR-12")).toBe(join(root, "jira-work", "task", "BUTCHR-12"));
    expect(workspaceDirFor("BUTCHR-12")).toBe(join(root, "BUTCHR-12"));
    expect(agentIdOfWorkspacePath(join(root, "jira-work", "task", "BUTCHR-12"))).toBe("jira-work:task:BUTCHR-12");
    expect(agentIdOfWorkspacePath(join(root, "jira-work", "task", "BUTCHR-12") + "/")).toBe("jira-work:task:BUTCHR-12");
    expect(agentIdOfWorkspacePath(join(root, "BUTCHR-12"))).toBe("BUTCHR-12");
    for (const cwd of [join(root, "jira-work", "task"), join(root, "jira-work", "Task", "BUTCHR-12"), join(root, "other", "task", "BUTCHR-12"), join(root, "jira-work", "task", "BUTCHR-12", "src"), root, "/elsewhere/jira-work/task/BUTCHR-12"]) {
      const id = agentIdOfWorkspacePath(cwd);
      expect(id === null || !ownsRuleAgent(id)).toBe(true);
    }
    expect(resourceKeyOf("jira-work:task:BUTCHR-12")).toBe("BUTCHR-12");
    expect(resourceKeyOf("BUTCHR-12")).toBe("BUTCHR-12");
  });

  test("a @builtin:<type> brief is written as that shipped brief, interpolated for the resource, with no raw placeholders", () => {
    const dir = buildWorkspace({ ...ruleSpec, key: "jira-work:bugs:BUTCHR-12", brief: "@builtin:bug", parent: "BUTCHR-1" }, "http://localhost:7717/mcp", "claude");
    const brief = readFileSync(join(dir, "brief.md"), "utf8");
    expect(brief.startsWith("# bugs agent — BUTCHR-12: fix it\n\n")).toBe(true);
    // the shipped bug brief's own text, not the @builtin reference and not the default brief
    expect(brief).not.toContain("@builtin:");
    expect(brief).toContain(briefFor("bug").split("\n").find((l) => l.trim() && !l.includes("{{"))!.trim());
    // every placeholder was filled in for the RESOURCE, never left raw or given the agent key
    expect(brief).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(brief).not.toContain("jira-work:bugs:BUTCHR-12");
    if (briefFor("bug").includes("{{KEY}}")) expect(brief).toContain("BUTCHR-12");
    if (briefFor("bug").includes("{{PARENT}}")) expect(brief).toContain("BUTCHR-1");
  });

  test("an inline rule brief is written as-is, with placeholders filled in for the resource", () => {
    const dir = buildWorkspace({ ...ruleSpec, brief: "Work {{KEY}} under {{PARENT}}." }, "http://localhost:7717/mcp", "claude");
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe("# task agent — BUTCHR-12: fix it\n\nWork BUTCHR-12 under (none — you are top-level).\n");
  });

  test("building a rule workspace leaves a legacy workspace for the same ticket byte-identical", () => {
    const legacy = join(root, "BUTCHR-12");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "brief.md"), "legacy brief");
    writeFileSync(join(legacy, "CLAUDE.md"), "legacy claude");
    const dir = buildWorkspace(ruleSpec, "http://localhost:7717/mcp", "claude");
    expect(dir).toBe(join(root, "jira-work", "task", "BUTCHR-12"));
    expect(readFileSync(join(legacy, "brief.md"), "utf8")).toBe("legacy brief");
    expect(readFileSync(join(legacy, "CLAUDE.md"), "utf8")).toBe("legacy claude");
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe("# task agent — BUTCHR-12: fix it\n\nRule brief body.\n");
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.butchr.headers).toEqual({ "x-issue": "BUTCHR-12", "x-butchr-agent": "jira-work:task:BUTCHR-12" });
  });

  test("the AGY bridge accepts a nested rule workspace only with matching agent metadata", () => {
    const dir = buildWorkspace(ruleSpec, "http://localhost:7717/mcp", "agy");
    expect(bridgeWorkspace(root, dir)).toEqual({ url: new URL("http://localhost:7717/mcp"), identity: "BUTCHR-12", agent: "jira-work:task:BUTCHR-12" });
    const meta = join(dir, ".butchr-agy.json");
    for (const bad of [{ issue: "BUTCHR-12", mcpUrl: "http://localhost:7717/mcp" }, { issue: "BUTCHR-12", agent: "jira-work:review:BUTCHR-12", mcpUrl: "http://localhost:7717/mcp" }, { issue: "BUTCHR-13", agent: "jira-work:task:BUTCHR-12", mcpUrl: "http://localhost:7717/mcp" }]) {
      writeFileSync(meta, JSON.stringify(bad));
      expect(() => bridgeWorkspace(root, dir)).toThrow();
    }
    const odd = join(root, "jira-work", "task");
    writeFileSync(join(odd, ".butchr-agy.json"), JSON.stringify({ issue: "task", mcpUrl: "http://localhost:7717/mcp" }));
    expect(() => bridgeWorkspace(root, odd)).toThrow("Not a factory workspace");
  });

  test("codex launches carry the agent header; claude honours a rule effort; neither reads as stale", () => {
    const codex = agentLaunchConfig(ruleSpec, "/d", "p", "n", { provider: "codex", disabledMcpServers: [] });
    expect(codex.provider === "codex" && codex.mcpServers[0]!.headers).toEqual({ "x-issue": "BUTCHR-12", "x-butchr-agent": "jira-work:task:BUTCHR-12", "x-butchr-provider": "codex" });
    const claude = agentLaunchConfig(ruleSpec, "/d", "p", "n", { provider: "claude", model: "opus", effort: "max" });
    expect(claude.provider === "claude" && [claude.model, claude.effort]).toEqual(["opus", "max"]);
  });

  test("the herd reports rule agents by key, legacy agents by bare key, and only rule agents survive ownership scoping", async () => {
    const ruleCwd = buildWorkspace(ruleSpec, "http://localhost:7717/mcp", "codex", []);
    const legacyCwd = join(root, "BUTCHR-12");
    mkdirSync(legacyCwd);
    const rows = [
      { pane_id: "p1", cwd: ruleCwd, agent_status: "working", workspace_id: "w1" },
      { pane_id: "p2", cwd: legacyCwd, agent_status: "idle", workspace_id: "w2" },
    ];
    const client = {
      agent: { list: async () => ({ agents: rows }) },
      pane: {
        list: async () => ({ panes: rows }),
        processInfo: async ({ pane_id }: { pane_id: string }) => ({ process_info: { foreground_processes: [{ name: "codex", argv: ["codex",
          ...spawnArgs(pane_id === "p1" ? ruleSpec : { key: "BUTCHR-12", issuetype: "task", summary: "", parent: null }, pane_id === "p1" ? ruleCwd : legacyCwd, { provider: "codex", disabledMcpServers: [] }, "http://localhost:7717/mcp")] }] } }),
      },
    };
    const herd = new HerdrHerd(client as never, "http://localhost:7717/mcp", async () => {}, undefined, { provider: "codex", disabledMcpServers: [] });
    expect((await herd.runningIssues()).sort()).toEqual(["BUTCHR-12", "jira-work:task:BUTCHR-12"]);
    expect(await herd.staleIssues()).toEqual([]);
    expect(await scopedHerd(herd, ownsRuleAgent).runningIssues()).toEqual(["jira-work:task:BUTCHR-12"]);
    expect(existsSync(join(legacyCwd, "brief.md"))).toBe(false);
  });

  test("residency and reaping locate rule workspaces by their nested path", () => {
    const cwd = join(root, "jira-work", "task", "BUTCHR-12");
    const panes = [{ pane_id: "p1", cwd, workspace_id: "w1" }, { pane_id: "p2", cwd: join(root, "BUTCHR-12"), workspace_id: "w2" }] as never[];
    expect(panesFor("jira-work:task:BUTCHR-12", panes, root).map((p: { pane_id: string }) => p.pane_id)).toEqual(["p1"]);
    expect([...groupOwnedPanes(panes, root).keys()].sort()).toEqual(["BUTCHR-12", "jira-work:task:BUTCHR-12"]);
    const workspaces = [{ workspace_id: "w1", label: "jira-work:task:BUTCHR-12" }] as never[];
    expect(strandedCandidates(workspaces, panes, [], root)).toEqual([{ workspaceId: "w1", label: "jira-work:task:BUTCHR-12", paneIds: ["p1"] }]);
  });
});
