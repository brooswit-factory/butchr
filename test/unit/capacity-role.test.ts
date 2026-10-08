import { describe, expect, test } from "bun:test";
import { capacityRoleFor } from "../../src/agents/capacity-role.js";
import { createAdmissionController, type AgentCapacityRole } from "../../src/agents/admission.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";

/**
 * FACTORY-757 (supersedes BUTCHR-422/FACTORY-39): capacity is decided
 * SOLELY by a rule's own `role` field — issue type (Epic/Story/Bug/Task/
 * Sub-task alike) no longer changes the outcome at all. A rule silent on
 * `role` is counted ("worker"), the field's own schema default. The only
 * agents that stay sentinel without a rule saying so are the two
 * construction-level exceptions: bare project-tier ids, and `jira-project`
 * agents (BUTCHR-425, kept migration-free on purpose — see
 * src/agents/capacity-role.ts's own doc comment).
 */

const noRuleRole = (): AgentCapacityRole | undefined => undefined;
const roleOf = (id: string) => capacityRoleFor(id, noRuleRole);

describe("capacityRoleFor (FACTORY-757)", () => {
  test("counted by default: a rule silent on role counts, for every issue type alike", () => {
    expect(roleOf("jira-work:epics:BUTCHR-1")).toBe("worker");
    expect(roleOf("jira-work:stories:BUTCHR-2")).toBe("worker");
    expect(roleOf("jira-work:tasks:BUTCHR-3")).toBe("worker");
    expect(roleOf("jira-work:subtasks:BUTCHR-4")).toBe("worker");
    expect(roleOf("jira-work:bugs:BUTCHR-5")).toBe("worker");
  });

  test("issue type no longer changes the outcome: same rule role, same decision for task-shaped and epic-shaped items", () => {
    const sentinelRule = (): AgentCapacityRole => "sentinel";
    expect(capacityRoleFor("jira-work:epics:BUTCHR-1", sentinelRule)).toBe("sentinel");
    expect(capacityRoleFor("jira-work:tasks:BUTCHR-3", sentinelRule)).toBe("sentinel");
    expect(capacityRoleFor("jira-work:bugs:BUTCHR-5", sentinelRule)).toBe("sentinel");
    const workerRule = (): AgentCapacityRole => "worker";
    expect(capacityRoleFor("jira-work:epics:BUTCHR-1", workerRule)).toBe("worker");
    expect(capacityRoleFor("jira-work:tasks:BUTCHR-3", workerRule)).toBe("worker");
  });

  test("one code path for every provider: github-issue and zendesk-ticket both defer to the rule's own role, with no provider branch", () => {
    const sentinelRule = (): AgentCapacityRole => "sentinel";
    const githubKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "triage", resourceId: "acme/widgets#99" });
    const zendeskKey = encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: "acme#123" });
    expect(capacityRoleFor(githubKey, noRuleRole)).toBe("worker");
    expect(capacityRoleFor(githubKey, sentinelRule)).toBe("sentinel");
    expect(capacityRoleFor(zendeskKey, noRuleRole)).toBe("worker");
    expect(capacityRoleFor(zendeskKey, sentinelRule)).toBe("sentinel");
  });

  test("a rule's own role still applies to leaf work", () => {
    const sentinelRule = (): AgentCapacityRole => "sentinel";
    expect(capacityRoleFor("jira-work:director:BUTCHR-3", sentinelRule)).toBe("sentinel");
    expect(capacityRoleFor("jira-work:tasks:BUTCHR-3", () => "worker")).toBe("worker");
  });

  test("project-tier agents (bare project key) are sentinel by construction, with no rule backing them at all", () => {
    expect(roleOf("BUTCHR")).toBe("sentinel");
    expect(roleOf("ATMO")).toBe("sentinel");
  });

  test("bare issue-key agents (no rule) fail safe to worker — uncounted only ever comes from a rule's own role", () => {
    expect(roleOf("BUTCHR-1")).toBe("worker");
    expect(roleOf("BUTCHR-3")).toBe("worker");
  });

  test("fail-safe: an id whose rule cannot be resolved stays counted — nothing escapes the cap by guessing", () => {
    expect(roleOf("jira-work:tasks:BUTCHR-999")).toBe("worker");
    expect(roleOf("BUTCHR-999")).toBe("worker");
    expect(roleOf("not a key at all")).toBe("worker");
  });

  test("BUTCHR-425: jira-project agents are always sentinel, never workers, even when their rule's own role is \"worker\" (the default a rule file that omits `role` gets)", () => {
    const alwaysWorker = (): AgentCapacityRole => "worker";
    expect(capacityRoleFor("jira-project:managers:BUTCHR", alwaysWorker)).toBe("sentinel");
    expect(capacityRoleFor("jira-project:managers:BUTCHR", noRuleRole)).toBe("sentinel");
    expect(roleOf("jira-project:managers:ATMO")).toBe("sentinel");
  });
});

describe("admission with per-rule capacity (FACTORY-757)", () => {
  test("uncounted (sentinel) rule's agents consume no slot and are never withheld, even with the cap full", async () => {
    const roleOf = (id: string): AgentCapacityRole => (id.includes("epics") ? "sentinel" : "worker");
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:tasks:BUTCHR-3"], roleOf });
    const admitted = await ctrl.admit(["jira-work:epics:BUTCHR-1"], []);
    expect(admitted).toEqual(["jira-work:epics:BUTCHR-1"]);
  });

  test("counted (worker) agent IS withheld with the cap full", async () => {
    const roleOf = (id: string): AgentCapacityRole => (id.includes("epics") ? "sentinel" : "worker");
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["jira-work:tasks:BUTCHR-3"], roleOf });
    const admitted = await ctrl.admit(["jira-work:tasks:BUTCHR-4"], []);
    expect(admitted).toEqual([]);
  });

  test("resident sentinel/project agents consume no slots — only worker rules are counted", async () => {
    const ctrl = createAdmissionController({
      cap: 1,
      residency: async () => ["BUTCHR", "jira-work:epics:BUTCHR-1", "jira-work:stories:BUTCHR-2"],
      roleOf: (id) => capacityRoleFor(id, (rid) => (rid.includes("epics") || rid.includes("stories") ? "sentinel" : undefined)),
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
