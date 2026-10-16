/**
 * FACTORY-1013 — the capacity admission system is GONE, and these tests are
 * what keep it gone. Every assertion here fails the moment anything
 * reintroduces a cap, a waiting queue, a fairness ordering or a pacing delay
 * between "this resource matched an enabled rule" and "its agent is running",
 * whatever that thing is called.
 *
 * Driven through the REAL producers — `createRuleResourceType` +
 * `desiredFrom` + `reconcileNow` + `createResidencyGuard` + `parseRules` —
 * never a hand-built `desired` map that merely happens to typecheck, so a
 * cap reintroduced ANYWHERE on that path is caught here rather than only in
 * whatever module happened to grow it.
 *
 * The three claims, in order:
 *   (a) NO CAP: every eligible match is reconciled into its agent on the poll
 *       it is first seen, at a fleet size far above every limit this codebase
 *       ever shipped (the old `BUTCHR_MAX_AGENTS` default was 8, its confirm
 *       ceiling 50, its hard maximum 100) — and in ONE poll, not spread
 *       across several.
 *   (b) STILL IDEMPOTENT: repeated polls never spawn a second agent for a
 *       resource that already has one. This is `checkResidency`
 *       (src/agents/residency-guard.ts), which SURVIVED FACTORY-1013
 *       deliberately — it answers "does this resource already have an owner",
 *       not "is the fleet full".
 *   (c) ENABLEMENT AND EXPLICIT STOPS STILL WORK: a disabled rule stops its
 *       agents, and an explicitly stopped/asleep resource stays stopped.
 *       Neither is capacity, and neither changed.
 */
import { describe, expect, test } from "bun:test";
import { atRestFrom, desiredFrom, reconcileNow } from "../../src/daemon/loop.js";
import { createRuleResourceType, type RuleMatch } from "../../src/rules/resource-type.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";
import { createResidencyGuard } from "../../src/agents/residency-guard.js";
import type { ResidencyVerdict } from "../../src/agents/residency-census.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { ResourceType } from "../../src/resources/types.js";

/**
 * Far above every capacity limit this codebase ever shipped: the deleted
 * `BUTCHR_MAX_AGENTS` defaulted to 8, needed `confirm: true` above 50, and
 * refused anything above 100 outright. 137 is deliberately none of those
 * numbers, so a test that passes here cannot be passing because it happens
 * to sit under some newly-introduced round limit.
 */
const FLEET = 137;

const issue = (key: string): JiraIssue => ({
  key, status: "In Progress", summary: `summary ${key}`, issuetype: "Task",
  assignee: "a", parent: null, updated: "t", labels: [],
});

/** Built through `parseRules` itself, never a hand-written literal — so this fixture carries exactly the defaults the daemon's own loader resolves. */
function rules(over: Record<string, unknown> = {}): Rule[] {
  return parseRules({ rules: [{ id: "tasks", resourceProvider: "jira-work", query: "status = \"In Progress\"", brief: "do it", ...over }] });
}

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string>; spawnedSpecs: SpawnSpec[] } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [], spawnedSpecs: SpawnSpec[] = [];
  return {
    running, spawned, stopped, spawnedSpecs,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); spawnedSpecs.push(sp); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
    async resumeInPlace() { return "unresumable" as const; },
  };
}

/** The REAL rule resource type over a fake Jira search — this is what turns a rule + matched issues into the execution units `desiredFrom` consumes. */
function ruleType(rs: readonly Rule[], issues: readonly JiraIssue[]): ResourceType<ExecutionUnit<RuleMatch>> {
  return createRuleResourceType({ rules: rs, search: async () => [...issues] });
}

async function unitsOf(rs: readonly Rule[], issues: readonly JiraIssue[]): Promise<{ type: ResourceType<ExecutionUnit<RuleMatch>>; units: readonly ExecutionUnit<RuleMatch>[] }> {
  const type = ruleType(rs, issues);
  return { type, units: await type.discovery.search() };
}

describe("FACTORY-1013 (a): no cap — every eligible match is reconciled into its agent, in ONE poll", () => {
  test(`${FLEET} eligible matches (far above every limit the deleted cap ever shipped) ALL spawn on the first poll`, async () => {
    const issues = Array.from({ length: FLEET }, (_, i) => issue(`KAN-${i + 1}`));
    const { type, units } = await unitsOf(rules(), issues);
    expect(units).toHaveLength(FLEET); // every match is its own execution unit (swarm)

    const desired = desiredFrom(units, type);
    expect(desired.size).toBe(FLEET);

    const herd = fakeHerd();
    await reconcileNow(herd, desired);

    // Not "most of them", not "the first N", not "spread over several polls":
    // exactly the full desired set, on this one poll.
    expect(herd.spawned).toHaveLength(FLEET);
    expect(new Set(herd.spawned)).toEqual(new Set(desired.keys()));
    expect(herd.stopped).toEqual([]);
  });

  test("a SECOND poll that adds another full fleet's worth of matches spawns every new one immediately — no residual budget, no backlog", async () => {
    const first = Array.from({ length: FLEET }, (_, i) => issue(`KAN-${i + 1}`));
    const second = [...first, ...Array.from({ length: FLEET }, (_, i) => issue(`KAN-${FLEET + i + 1}`))];
    const herd = fakeHerd();

    const a = await unitsOf(rules(), first);
    await reconcileNow(herd, desiredFrom(a.units, a.type));
    expect(herd.running.size).toBe(FLEET);

    const b = await unitsOf(rules(), second);
    await reconcileNow(herd, desiredFrom(b.units, b.type));
    expect(herd.running.size).toBe(FLEET * 2);
    expect(herd.spawned).toHaveLength(FLEET * 2); // every one of them, never queued
  });

  test("a rules.json that still carries the deleted capacity fields loads, and they change nothing: the fleet still starts in full", async () => {
    // The capacity fields are accepted-and-ignored for upgrade safety only
    // (`REMOVED_RULE_FIELDS`, src/rules/rules.ts) — never parsed onto `Rule`,
    // never read. A deployed rules.json written against the old schema must
    // keep loading, and must NOT get the old rationing back.
    const parsed = rules({ role: "sentinel", maxNewPerTick: 1, minSecondsBetweenAdmissions: 600 });
    expect(parsed).toHaveLength(1);
    expect("role" in parsed[0]!).toBe(false);
    expect("maxNewPerTick" in parsed[0]!).toBe(false);
    expect("minSecondsBetweenAdmissions" in parsed[0]!).toBe(false);

    const issues = Array.from({ length: FLEET }, (_, i) => issue(`KAN-${i + 1}`));
    const { type, units } = await unitsOf(parsed, issues);
    const herd = fakeHerd();
    await reconcileNow(herd, desiredFrom(units, type));
    // `maxNewPerTick: 1` would have admitted exactly one per poll; it admits all of them.
    expect(herd.spawned).toHaveLength(FLEET);
  });

  test("an unrecognised field is still a hard load error — the removed-field tolerance is a named list, never a blanket 'ignore anything'", () => {
    expect(() => rules({ maxNewPerSecond: 1 })).toThrow(/unknown field "maxNewPerSecond"/);
  });
});

describe("FACTORY-1013 (b): idempotent reconciliation — a repeated poll never duplicates an agent", () => {
  test("ten identical polls over the same matches spawn each resource exactly once", async () => {
    const issues = Array.from({ length: 12 }, (_, i) => issue(`KAN-${i + 1}`));
    const herd = fakeHerd();
    for (let poll = 0; poll < 10; poll++) {
      const { type, units } = await unitsOf(rules(), issues);
      await reconcileNow(herd, desiredFrom(units, type));
    }
    expect(herd.spawned).toHaveLength(12); // not 120
    expect(new Set(herd.spawned).size).toBe(12);
    expect(herd.stopped).toEqual([]);
  });

  test("the residency guard still drops a candidate that already has a live agent the running list has not caught up on — one owner per resource", async () => {
    // The hazard this guard exists for: `herd.runningIssues()` reports a
    // resource as NOT running (so it lands in `plan.spawn`) while a live
    // agent for it actually exists. Without the guard, that poll spawns a
    // DUPLICATE. This is not capacity: the fleet below is nowhere near any
    // size, and nothing else is withheld.
    const issues = [issue("KAN-1"), issue("KAN-2")];
    const { type, units } = await unitsOf(rules(), issues);
    const desired = desiredFrom(units, type);
    const [resident, vacant] = [...desired.keys()];

    const herd = fakeHerd(); // runningIssues() says NOTHING is running
    const guard = createResidencyGuard({
      census: async (candidates) =>
        new Map<string, ResidencyVerdict>(candidates.map((id) => [id, id === resident ? "resident" : "vacant"])),
    });

    await reconcileNow(herd, desired, { checkResidency: guard.filter });
    expect(herd.spawned).toEqual([vacant!]); // the already-owned resource is not spawned a second time
    expect(herd.spawned).not.toContain(resident);
  });

  test("a skipped-because-already-resident candidate is offered again, and spawns, the moment its agent genuinely exits — `desired` never shrank", async () => {
    const issues = [issue("KAN-1")];
    const { type, units } = await unitsOf(rules(), issues);
    const desired = desiredFrom(units, type);
    const id = [...desired.keys()][0]!;

    const herd = fakeHerd();
    let stillResident = true;
    const guard = createResidencyGuard({
      census: async (candidates) => new Map<string, ResidencyVerdict>(candidates.map((c) => [c, stillResident ? "resident" : "vacant"])),
    });

    await reconcileNow(herd, desired, { checkResidency: guard.filter });
    expect(herd.spawned).toEqual([]);

    stillResident = false; // the pre-existing agent exits between polls
    await reconcileNow(herd, desired, { checkResidency: guard.filter });
    expect(herd.spawned).toEqual([id]);
  });
});

describe("FACTORY-1013 (c): query enablement and explicit stops are untouched by the removal", () => {
  test("a disabled rule desires nothing and its running agents are stopped — `enabled: false` still means stopped", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => issue(`KAN-${i + 1}`));
    const herd = fakeHerd();

    const on = await unitsOf(rules(), issues);
    const desired = desiredFrom(on.units, on.type);
    await reconcileNow(herd, desired);
    expect(herd.running.size).toBe(5);

    const off = await unitsOf(rules({ enabled: false }), issues);
    expect(off.units).toEqual([]); // a disabled rule contributes no execution units at all
    await reconcileNow(herd, desiredFrom(off.units, off.type));
    expect(herd.stopped.sort()).toEqual([...desired.keys()].sort());
    expect(herd.running.size).toBe(0);
  });

  test("a resource no enabled rule matches any more is stopped, while every still-matched one keeps its SAME agent (never stopped and respawned)", async () => {
    const all = Array.from({ length: 6 }, (_, i) => issue(`KAN-${i + 1}`));
    const herd = fakeHerd();

    const before = await unitsOf(rules(), all);
    await reconcileNow(herd, desiredFrom(before.units, before.type));
    const spawnedFirst = [...herd.spawned];

    const after = await unitsOf(rules(), all.slice(0, 4)); // two tickets left the query
    const stillDesired = desiredFrom(after.units, after.type);
    await reconcileNow(herd, stillDesired);

    expect(herd.stopped).toHaveLength(2);
    expect(herd.spawned).toEqual(spawnedFirst); // no re-spawn of the four that stayed
    expect(new Set(herd.running)).toEqual(new Set(stillDesired.keys()));
  });

  test("an explicitly stopped (asleep) resource stays stopped: it is never desired, and `atRest` keeps the reconciler from fighting its own exit", async () => {
    // `"asleep"` is the explicit-stop verdict a resource type reports for a
    // resource an operator (or the agent's own `stand_down`) has stood down
    // — a DIFFERENT mechanism from capacity, and deliberately untouched by
    // FACTORY-1013. `desiredFrom` excludes it; `atRestFrom` keeps
    // `stop = running - desired` from re-stopping it mid-exit.
    const asleepId = "jira-work:tasks:KAN-9";
    const activeId = "jira-work:tasks:KAN-1";
    const items = [{ id: activeId, verdict: "active" as const }, { id: asleepId, verdict: "asleep" as const }];
    const type = {
      activation: { verdictFor: (i: typeof items[number]) => i.verdict },
      discovery: { idOf: (i: typeof items[number]) => i.id, search: async () => items },
      spawnConfig: { specFor: (i: typeof items[number]): SpawnSpec => ({ key: i.id, issuetype: "Task", summary: "s", parent: null }) },
    };

    const desired = desiredFrom(items, type);
    expect([...desired.keys()]).toEqual([activeId]); // the stood-down resource is NOT desired

    const herd = fakeHerd([asleepId]); // its agent is still winding down
    await reconcileNow(herd, desired, { atRest: atRestFrom(items, type) });

    expect(herd.spawned).toEqual([activeId]);
    expect(herd.stopped).toEqual([]); // atRest protects the mid-exit asleep agent from a redundant stop
    expect(herd.spawned).not.toContain(asleepId); // and it is never restarted "because there is room"
  });
});
