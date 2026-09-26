import { describe, expect, test } from "bun:test";
import { capacityRoleFor, UNCOUNTED_ISSUE_TYPES } from "../../src/agents/capacity-role.js";
import { createAdmissionController, type AgentCapacityRole } from "../../src/agents/admission.js";

/**
 * BUTCHR-422 — the fleet cap counts only leaf work (Task, Sub-task).
 * Project agents and Epic/Story/Bug agents are classified "sentinel": never
 * counted toward `maxAgents`, never withheld. `capacity-role.ts` does not
 * exist before this change, so this whole file fails to load on prior main.
 *
 * FACTORY-39 (FACTORY-37, review fix): Bug moved from the counted set to
 * the uncounted one here — a Bug is now a BOSS, the same tier as an Epic,
 * so it idles while its Stories run exactly like an Epic does, and must be
 * exempt from the cap the same way. The expectations this pinned for Bug as
 * a worker are an intended spec change, authorized at review, not a
 * weakening — Task and Sub-task stay counted.
 */

const types: Record<string, string> = {
  "BUTCHR-1": "Epic", "BUTCHR-2": "Story", "BUTCHR-3": "Task", "BUTCHR-4": "Sub-task", "BUTCHR-5": "Bug", "BUTCHR-6": "story",
};
const issuetypeOf = (key: string) => types[key];
const noRuleRole = (): AgentCapacityRole | undefined => undefined;
const roleOf = (id: string) => capacityRoleFor(id, noRuleRole, issuetypeOf);

describe("capacityRoleFor (BUTCHR-422)", () => {
  test("Epic, Story and Bug agents are uncounted (sentinel); Task and Sub-task are counted (worker)", () => {
    expect(roleOf("jira-work:epics:BUTCHR-1")).toBe("sentinel");
    expect(roleOf("jira-work:stories:BUTCHR-2")).toBe("sentinel");
    expect(roleOf("jira-work:tasks:BUTCHR-3")).toBe("worker");
    expect(roleOf("jira-work:subtasks:BUTCHR-4")).toBe("worker");
    expect(roleOf("jira-work:bugs:BUTCHR-5")).toBe("sentinel"); // FACTORY-39: Bug is a boss now, not leaf work
  });

  test("issue type matching is case- and whitespace-insensitive", () => {
    expect(roleOf("jira-work:stories:BUTCHR-6")).toBe("sentinel");
    expect([...UNCOUNTED_ISSUE_TYPES].sort()).toEqual(["bug", "epic", "story"]);
  });

  test("project-tier agents (bare project key) are uncounted", () => {
    expect(roleOf("BUTCHR")).toBe("sentinel");
    expect(roleOf("ATMO")).toBe("sentinel");
  });

  test("bare issue-key agents follow the same issue-type rule", () => {
    expect(roleOf("BUTCHR-1")).toBe("sentinel");
    expect(roleOf("BUTCHR-3")).toBe("worker");
  });

  test("fail-safe: an unknown issue type stays counted — nothing escapes the cap by guessing", () => {
    expect(roleOf("jira-work:tasks:BUTCHR-999")).toBe("worker");
    expect(roleOf("BUTCHR-999")).toBe("worker");
    expect(roleOf("not a key at all")).toBe("worker");
  });

  test("a rule's own BUTCHR-398 role still applies to leaf work", () => {
    const sentinelRule = (): AgentCapacityRole => "sentinel";
    expect(capacityRoleFor("jira-work:director:BUTCHR-3", sentinelRule, issuetypeOf)).toBe("sentinel");
    expect(capacityRoleFor("jira-work:tasks:BUTCHR-3", () => "worker", issuetypeOf)).toBe("worker");
  });

  test("Epic/Story/Bug stay uncounted even if their rule says worker", () => {
    expect(capacityRoleFor("jira-work:epics:BUTCHR-1", () => "worker", issuetypeOf)).toBe("sentinel");
    expect(capacityRoleFor("jira-work:bugs:BUTCHR-5", () => "worker", issuetypeOf)).toBe("sentinel");
  });

  test("BUTCHR-425: jira-project agents are always sentinels, never workers, even when their rule's own role is \"worker\" (the default a rule file that omits `role` gets)", () => {
    const alwaysWorker = (): AgentCapacityRole => "worker";
    expect(capacityRoleFor("jira-project:managers:BUTCHR", alwaysWorker, issuetypeOf)).toBe("sentinel");
    expect(capacityRoleFor("jira-project:managers:BUTCHR", noRuleRole, issuetypeOf)).toBe("sentinel");
    expect(roleOf("jira-project:managers:ATMO")).toBe("sentinel");
  });
});

describe("admission with leaf-only capacity (BUTCHR-422)", () => {
  test("with the cap full of Task agents, Epic, Story and Bug agents still start; another Task is withheld", async () => {
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:tasks:BUTCHR-3"], roleOf });
    const admitted = await ctrl.admit(["jira-work:epics:BUTCHR-1", "jira-work:stories:BUTCHR-2", "jira-work:bugs:BUTCHR-5"], []);
    expect(admitted).toEqual(["jira-work:epics:BUTCHR-1", "jira-work:stories:BUTCHR-2", "jira-work:bugs:BUTCHR-5"]);
  });

  test("resident Epic/Story/project agents consume no slots — only leaf work is counted", async () => {
    const ctrl = createAdmissionController({
      cap: 1,
      residency: async () => ["BUTCHR", "jira-work:epics:BUTCHR-1", "jira-work:stories:BUTCHR-2"],
      roleOf,
    });
    expect(await ctrl.admit(["jira-work:tasks:BUTCHR-3"], [])).toEqual(["jira-work:tasks:BUTCHR-3"]);
    expect(ctrl.snapshot()).toMatchObject({ residency: 0, sentinels: 3 });
  });

  test("BUTCHR-425: 23 resident jira-project agents consume no worker slots — the cap is still fully available to leaf work", async () => {
    const managers = Array.from({ length: 23 }, (_, i) => `jira-project:managers:PROJ${i}`);
    const ctrl = createAdmissionController({ cap: 1, residency: async () => managers, roleOf });
    expect(await ctrl.admit(["jira-work:tasks:BUTCHR-3"], [])).toEqual(["jira-work:tasks:BUTCHR-3"]);
    expect(ctrl.snapshot()).toMatchObject({ residency: 0, sentinels: 23 });
  });
});
