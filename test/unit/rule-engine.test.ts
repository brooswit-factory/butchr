import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueLink, JiraIssue } from "../../src/atlassian/types.js";
import type { Herd } from "../../src/agents/herd.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import { spawnArgs, agentLaunchConfig } from "../../src/agents/argv.js";
import { agentIdOfWorkspacePath, buildWorkspace, resourceKeyOf, workspaceDirFor } from "../../src/agents/workspace.js";
import { panesFor, groupOwnedPanes } from "../../src/agents/residency-census.js";
import { strandedCandidates } from "../../src/agents/reap.js";
import { desiredFrom, reconcileNow, runResourceLoop, scopedHerd } from "../../src/daemon/loop.js";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";
import { createOwnWriteLedger } from "../../src/jira-watch/own-writes.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import { createRuleEventRules, createRuleResourceType, ownsRuleAgent, relatedForRules, searchRules, specForMatch, uniqueIssues, type RuleMatch } from "../../src/rules/resource-type.js";

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue =>
  ({ key, status: "In Progress", summary: `summary of ${key}`, issuetype: "Task", assignee: "me", parent: null, updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over });

const rules = (...docs: object[]): Rule[] =>
  parseRules({ rules: docs.map((d) => ({ resourceProvider: "jira-work", brief: "do it", ...d })) });

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
async function poll(herd: Herd, ruleSet: Rule[], search: (jql: string) => Promise<JiraIssue[]>): Promise<RuleMatch[]> {
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
    expect(uniqueIssues(matches).map((i) => i.key)).toEqual(["BUTCHR-1", "BUTCHR-2"]);
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
  const snapshot = (primary: RuleMatch[]) => ({ primary, related: [] });
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

  test("the boss rule's agent watches its child-rule worker; the unrelated rule on either ticket does not", () => {
    const ms = world(worker());
    expect(relatedForRules(ruleSet, ms, keys(ms))).toEqual([
      { issue: match(byId(ruleSet, "story"), worker()), watchers: ["jira-work:epic:BUTCHR-1"] },
    ]);
  });

  test("the worker never watches its boss, and only active agents watch", () => {
    const ms = world(worker());
    expect(relatedForRules(ruleSet, ms, keys(ms)).flatMap((r) => r.watchers)).not.toContain("jira-work:story:BUTCHR-2");
    expect(relatedForRules(ruleSet, ms, keys(ms).filter((k) => k !== "jira-work:epic:BUTCHR-1"))).toEqual([]);
  });

  test("an inward connection rule hears the connecting rule's ticket; the link is read from either end", () => {
    const b = issue("BUTCHR-1"), w = worker();
    const ms = [match(byId(ruleSet, "audit"), b), match(byId(ruleSet, "story"), w)];
    expect(relatedForRules(ruleSet, ms, keys(ms))).toEqual([{ issue: ms[1]!, watchers: ["jira-work:audit:BUTCHR-1"] }]);
    const fromBossEnd = [match(byId(ruleSet, "audit"), boss()), match(byId(ruleSet, "story"), issue("BUTCHR-2"))];
    expect(relatedForRules(ruleSet, fromBossEnd, keys(fromBossEnd))[0]!.watchers).toEqual(["jira-work:audit:BUTCHR-1"]);
  });

  test("a missing or invalid relationship routes nothing, without disturbing a valid one", () => {
    const epic = byId(ruleSet, "epic"), story = byId(ruleSet, "story"), review = byId(ruleSet, "review");
    const cases: Array<[string, RuleMatch[]]> = [
      ["no link", [match(epic, issue("BUTCHR-1")), match(story, issue("BUTCHR-2"))]],
      ["a Relates link", [match(epic, issue("BUTCHR-1", { issuelinks: [{ type: "Relates", otherEnd: "outward", key: "BUTCHR-2" }] })), match(story, issue("BUTCHR-2"))]],
      ["a reversed Implements link (boss implements worker)", [match(epic, issue("BUTCHR-1", { issuelinks: implementsBoss("BUTCHR-2") })), match(story, issue("BUTCHR-2", { issuelinks: implementedBy("BUTCHR-1") }))]],
      ["the worker matched only by a rule the boss does not hear", [match(epic, boss()), match(review, worker())]],
      ["a link to a ticket no rule matches", [match(epic, issue("BUTCHR-1", { issuelinks: implementedBy("BUTCHR-99") })), match(story, issue("BUTCHR-2", { issuelinks: implementsBoss("BUTCHR-98") }))]],
    ];
    for (const [, ms] of cases) expect(relatedForRules(ruleSet, ms, keys(ms))).toEqual([]);

    // One bad link beside a good one: only the good one routes.
    const mixed = [
      match(epic, issue("BUTCHR-1", { issuelinks: [...implementedBy("BUTCHR-2"), ...implementedBy("BUTCHR-3")] })),
      match(story, worker()),
      match(review, issue("BUTCHR-3", { issuelinks: implementsBoss("BUTCHR-1") })),
    ];
    expect(relatedForRules(ruleSet, mixed, keys(mixed)).map((r) => [r.issue.issue.key, r.watchers])).toEqual([["BUTCHR-2", ["jira-work:epic:BUTCHR-1"]]]);
  });

  test("a worker matched by several rules is one entry; several boss rules on one ticket each watch under their own key", () => {
    const two = rules(
      { id: "epic", query: "q", relationships: { childRule: "story" } },
      { id: "lead", query: "q", relationships: { inwardConnectionRules: ["story", "spike"] } },
      { id: "story", query: "q" },
      { id: "spike", query: "q" },
    );
    const ms = [
      match(byId(two, "epic"), boss()), match(byId(two, "lead"), boss()),
      match(byId(two, "story"), worker()), match(byId(two, "spike"), worker()),
    ];
    expect(relatedForRules(two, ms, keys(ms))).toEqual([
      { issue: ms[3]!, watchers: ["jira-work:epic:BUTCHR-1", "jira-work:lead:BUTCHR-1"] },
    ]);
  });

  test("the boss learns a child's status change, once, and no other agent does", async () => {
    const events = createRuleEventRules({ rules: ruleSet });
    const snap = (ms: RuleMatch[]) => ({ primary: ms, related: relatedForRules(ruleSet, ms, keys(ms)) });
    const before = world(worker()), after = world(worker({ status: "In Review", updated: "later" }));
    const ev = await events.poll(snap(before), snap(after));
    expect(ev.changedRelated).toEqual(["jira-work:story:BUTCHR-2"]);
    expect(await ev.decide("jira-work:story:BUTCHR-2", "jira-work:epic:BUTCHR-1", "related")).toEqual({ deliver: true, reason: { status: { from: "In Progress", to: "In Review" } } });
    for (const other of ["jira-work:review:BUTCHR-1", "jira-work:story:BUTCHR-2", "jira-work:audit:BUTCHR-1"]) {
      expect(await ev.decide("jira-work:story:BUTCHR-2", other, "related")).toEqual({ deliver: false });
    }
    // The worker's own agents still hear it on the primary path, each under its own key.
    expect([...ev.changedPrimary].sort()).toEqual(["jira-work:review:BUTCHR-2", "jira-work:story:BUTCHR-2"]);
  });

  test("a worker agent's own write is swallowed for itself but still reaches its boss", async () => {
    const ledger = createOwnWriteLedger();
    ledger.record("BUTCHR-2", "later", "jira-work:story:BUTCHR-2", Date.now());
    const events = createRuleEventRules({ rules: ruleSet, suppress: (key, updated, watcher) => ledger.shouldSuppress(key, updated, watcher, Date.now()), comments: async () => [] });
    const snap = (ms: RuleMatch[]) => ({ primary: ms, related: relatedForRules(ruleSet, ms, keys(ms)) });
    const ev = await events.poll(snap(world(worker())), snap(world(worker({ status: "In Review", updated: "later" }))));
    expect((await ev.decide("jira-work:story:BUTCHR-2", "jira-work:story:BUTCHR-2", "primary")).deliver).toBe(false);
    expect((await ev.decide("jira-work:story:BUTCHR-2", "jira-work:epic:BUTCHR-1", "related")).deliver).toBe(true);
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
    expect(notified.filter((n) => n.startsWith("jira-work:epic:"))).toEqual(["jira-work:epic:BUTCHR-1 <- jira-work:story:BUTCHR-2"]);
    expect(notified.filter((n) => n.includes("BUTCHR-1 <-") && !n.startsWith("jira-work:epic:"))).toEqual([]);
    expect(notified.filter((n) => n.startsWith("jira-work:story:BUTCHR-2") || n.startsWith("jira-work:review:BUTCHR-2")).sort())
      .toEqual(["jira-work:review:BUTCHR-2 <- jira-work:review:BUTCHR-2", "jira-work:story:BUTCHR-2 <- jira-work:story:BUTCHR-2"]);
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
