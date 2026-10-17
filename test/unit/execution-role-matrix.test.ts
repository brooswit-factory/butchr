/**
 * BUTCHR-464: the {swarm,singleton,persistent} x {worker,sentinel} matrix,
 * run through the real reconciler and the real admission controller.
 * `execution` only changes WHICH KEY SHAPE an agent gets (`encodeAgentKey`
 * vs `encodeQueryAgentKey`, `src/rules/agent-key.ts`); `role` only changes
 * WHETHER an id counts toward the fleet-wide admission cap at all
 * (`src/agents/admission.ts`'s `roleOf`). So every cell must show the same
 * role behaviour regardless of its execution mode: a worker is withheld when
 * the worker cap is fully saturated, and a sentinel starts anyway.
 */
import { describe, expect, test } from "bun:test";
import { reconcileNow } from "../../src/daemon/loop.js";
import { encodeAgentKey, encodeQueryAgentKey, decodeAnyAgentKey } from "../../src/rules/agent-key.js";
import type { AgentRole, ExecutionMode } from "../../src/rules/rules.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import { createAdmissionController, type AgentCapacityRole } from "../../src/agents/admission.js";

interface TestRule { id: string; execution: ExecutionMode; role: AgentRole }

const EXECUTIONS: readonly ExecutionMode[] = ["swarm", "singleton", "persistent"];
const ROLES: readonly AgentRole[] = ["worker", "sentinel"];

/** One rule per (execution, role) cell, mirroring what a real rules.json would declare. */
const RULES: TestRule[] = EXECUTIONS.flatMap((execution) => ROLES.map((role) => ({ id: `${execution}-${role}`, execution, role })));

/** BUTCHR-398's `AdmissionControllerDeps.roleOf` shape; every RULES id is unique, so a global lookup is valid. */
const roleOf = (id: string): AgentCapacityRole => {
  const decoded = decodeAnyAgentKey(id);
  const rule = RULES.find((r) => r.id === decoded?.ruleId);
  return rule?.role ?? "worker";
};

/** The one agent key each rule's agent runs under — a swarm rule's single matched ticket, or a singleton/persistent rule's one query-level agent. */
const keyFor = (rule: TestRule): string =>
  rule.execution === "swarm"
    ? encodeAgentKey({ resourceProvider: "jira-work", ruleId: rule.id, resourceId: "TCK-1" })
    : encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: rule.id });

function fakeHerd(): Herd & { running: Set<string>; spawnedSpecs: Map<string, SpawnSpec> } {
  const running = new Set<string>();
  const spawnedSpecs = new Map<string, SpawnSpec>();
  return {
    running, spawnedSpecs,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(spec) { spawnedSpecs.set(spec.key, spec); running.add(spec.key); },
    async stop(id) { running.delete(id); },
    async paneFor(id) { return running.has(id) ? `pane-${id}` : null; },
    async nudge() { return { delivered: true }; },
    async resumeInPlace() { return "unresumable" as const; },
  };
}

describe("BUTCHR-464: role capacity behaviour, per cell (fleet-wide cap fully saturated)", () => {
  test.each(RULES.map((r) => [r.id, r] as const))("cell %s: a worker is withheld and a sentinel starts, when the fleet-wide worker cap is 0", async (_id, rule) => {
    const key = keyFor(rule);
    const herd = fakeHerd();
    // cap:0 with a cold-start census (nothing was ever trusted positive
    // before this first read, so a readable 0 is trusted immediately, not
    // the BUTCHR-282 implausible-zero shape — see admission.test.ts's own
    // "cold start" case): budget = 0 - 0 = 0 for every WORKER candidate.
    // Sentinels bypass the budget check entirely (src/agents/admission.ts).
    const admissionCtrl = createAdmissionController({ cap: 0, residency: () => herd.runningIssues(), roleOf });
    const spec: SpawnSpec = { key, issuetype: "task", summary: rule.id, parent: null };

    await reconcileNow(herd, new Map([[key, spec]]), { admission: admissionCtrl.admit.bind(admissionCtrl) });

    if (rule.role === "worker") {
      expect(herd.spawnedSpecs.get(key), `cell ${rule.id}: a worker must be withheld when the worker cap is 0`).toBeUndefined();
      return;
    }
    expect(herd.spawnedSpecs.get(key), `cell ${rule.id}: a sentinel must start even when the worker cap is 0`).toEqual(spec);

    // Poll 2: this sentinel's agent stops once nothing desires it, at cap:0 too.
    await reconcileNow(herd, new Map(), { admission: admissionCtrl.admit.bind(admissionCtrl) });
    expect(herd.running.has(key), `cell ${rule.id}`).toBe(false);
  });
});
