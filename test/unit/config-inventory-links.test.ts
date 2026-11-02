import { describe, expect, test } from "bun:test";
import { agentRowAnchorId, agentRowsForRule, configAnchorForResourceKey, ruleAnchorId } from "../../src/agents/config-inventory-links.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import type { AgentDashboardRow, DashboardRow, WithheldDashboardRow } from "../../src/agents/dashboard.js";

const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true };
function agentRow(resourceKey: string): AgentDashboardRow {
  return { kind: "agent", resourceKey, tier: { kind: "project" }, agentStatus: "working", pane: "p1", timeInStatus: floor, confirmedAt: new Date(0).toISOString() };
}
function withheldRow(resourceKey: string, source = "issue"): WithheldDashboardRow {
  return { kind: "withheld", resourceKey, tier: { kind: "project" }, source, waiting: floor, confirmedAt: new Date(0).toISOString(), agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" } };
}

describe("agentRowsForRule (FACTORY-81) — a rule matches a LIVE row iff decodeAnyAgentKey gives the same (resourceProvider, ruleId)", () => {
  test("an ordinary per-resource swarm match", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    const rows: DashboardRow[] = [agentRow(key)];
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, rows)).toEqual([agentRow(key)]);
  });

  test("a singleton/persistent rule's one query-level agent also matches", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" });
    const rows: DashboardRow[] = [agentRow(key)];
    expect(agentRowsForRule({ id: "director", resourceProvider: "filesystem" }, rows)).toEqual([agentRow(key)]);
  });

  test("a different rule id on the SAME provider does not match", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "other-rule", resourceProvider: "jira-work" }, [agentRow(key)])).toEqual([]);
  });

  test("the same rule id on a DIFFERENT provider does not match — both halves of the correlation key are required", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "github-issue" }, [agentRow(key)])).toEqual([]);
  });

  test("a withheld row never matches — only LIVE rows are 'running agent rows'", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [withheldRow(key)])).toEqual([]);
  });

  test("a resourceKey that fails to decode entirely is silently skipped, never thrown", () => {
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [agentRow("not-a-real-key")])).toEqual([]);
  });

  test("multiple matching resources for one swarm rule all come back", () => {
    const a = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    const b = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-2" });
    expect(agentRowsForRule({ id: "task", resourceProvider: "jira-work" }, [agentRow(a), agentRow(b)]).map((r) => r.resourceKey)).toEqual([a, b]);
  });
});

describe("configAnchorForResourceKey (FACTORY-81) — the back-link target, computed WITHOUT the inventory in hand", () => {
  test("an ordinary rule-driven row anchors to that rule's own anchor id", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "task", resourceId: "BUTCHR-1" });
    expect(configAnchorForResourceKey(key)).toBe(ruleAnchorId("jira-work", "task"));
  });

  test("a query-level agent's row anchors to the same rule anchor id as a per-resource row would", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "filesystem", ruleId: "director" });
    expect(configAnchorForResourceKey(key)).toBe(ruleAnchorId("filesystem", "director"));
  });

  test("a resourceKey that fails to decode entirely yields null — nothing to link to", () => {
    expect(configAnchorForResourceKey("not-a-real-key")).toBeNull();
  });
});

describe("anchor ids (FACTORY-81) — stable, distinct, and safe as both an HTML id and a URL fragment", () => {
  test("agentRowAnchorId is distinct for distinct resource keys, and does not contain characters that would break an id or fragment", () => {
    const a = agentRowAnchorId("jira-work:task:BUTCHR-1");
    const b = agentRowAnchorId("jira-work:task:BUTCHR-2");
    expect(a).not.toBe(b);
    for (const s of [a, b]) expect(s).toMatch(/^agent-[A-Za-z0-9._%-]+$/);
  });
});
