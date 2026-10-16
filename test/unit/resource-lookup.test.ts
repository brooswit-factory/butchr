import { describe, expect, test } from "bun:test";
import { buildResourcesForUrlResponse } from "../../src/resources/resource-lookup.js";
import type { UrlToResourceDeps } from "../../src/resources/url-to-resource.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { AgentDashboardRow, DashboardRow, WithheldDashboardRow } from "../../src/agents/dashboard.js";

const deps: UrlToResourceDeps = { jiraHost: "acme.atlassian.net", zendeskSubdomain: "acme" };
const url = "https://acme.atlassian.net/browse/BUTCHR-12";

const floor = { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0m", exact: true };

function agentRow(ruleId: string, resourceId: string, pane: string): AgentDashboardRow {
  return {
    kind: "agent",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId, resourceId }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
    agentStatus: "working",
    pane,
    timeInStatus: floor,
    confirmedAt: new Date(0).toISOString(),
  };
}

function withheldRow(ruleId: string, resourceId: string): WithheldDashboardRow {
  return {
    kind: "withheld",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId, resourceId }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
    source: "issue",
    waiting: floor,
    confirmedAt: new Date(0).toISOString(),
    agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" },
  };
}

describe("buildResourcesForUrlResponse", () => {
  test("no resource: url and canonicalUrl are both present, resource and agents are null/[]", () => {
    const r = buildResourcesForUrlResponse("https://example.com/nope", deps, []);
    expect(r).toEqual({ url: "https://example.com/nope", canonicalUrl: "https://example.com/nope", resource: null, agents: [] });
  });
  test("a not-even-a-url input still returns the required shape (canonicalUrl null, resource null, agents [])", () => {
    const r = buildResourcesForUrlResponse("not a url", deps, []);
    expect(r).toEqual({ url: "not a url", canonicalUrl: null, resource: null, agents: [] });
  });
  test("resource resolves but nothing is staffed: agents is [] — distinguishable from 'not a resource' only via `resource`", () => {
    const r = buildResourcesForUrlResponse(url, deps, []);
    expect(r.resource).toEqual({ provider: "jira-work", id: "BUTCHR-12" });
    expect(r.agents).toEqual([]);
  });
  test("one live agent staffing the resource", () => {
    const rows: DashboardRow[] = [agentRow("triage", "BUTCHR-12", "pane-1")];
    const r = buildResourcesForUrlResponse(url, deps, rows);
    expect(r.agents).toEqual([{ agentKey: rows[0]!.resourceKey, ruleId: "triage", pane: "pane-1", live: true, label: "triage:BUTCHR-12" }]);
  });
  test("a withheld (not live) agent reports live:false and pane:null", () => {
    const rows: DashboardRow[] = [withheldRow("triage", "BUTCHR-12")];
    const r = buildResourcesForUrlResponse(url, deps, rows);
    expect(r.agents).toEqual([{ agentKey: rows[0]!.resourceKey, ruleId: "triage", pane: null, live: false, label: "triage:BUTCHR-12" }]);
  });
  test("several agents (several rules matching the same resource) are sorted deterministically by rule id", () => {
    const rows: DashboardRow[] = [agentRow("zzz-rule", "BUTCHR-12", "pane-z"), agentRow("aaa-rule", "BUTCHR-12", "pane-a"), agentRow("mmm-rule", "BUTCHR-12", "pane-m")];
    const r = buildResourcesForUrlResponse(url, deps, rows);
    expect(r.agents.map((a) => a.ruleId)).toEqual(["aaa-rule", "mmm-rule", "zzz-rule"]);
  });
  test("rows for a different resource, or a non-resource (query-kind) key, are excluded", () => {
    const rows: DashboardRow[] = [
      agentRow("triage", "BUTCHR-99", "pane-other"),
      { kind: "agent", resourceKey: "not:a:valid:key:at:all", tier: { kind: "issue", issuetype: { checked: false, declinedAt: new Date(0).toISOString() } }, agentStatus: "working", pane: "pane-x", timeInStatus: floor, confirmedAt: new Date(0).toISOString() },
    ];
    const r = buildResourcesForUrlResponse(url, deps, rows);
    expect(r.agents).toEqual([]);
  });
  test("label is rule id + resource id, joined with a colon, with no title fetch involved", () => {
    const rows: DashboardRow[] = [agentRow("triage", "BUTCHR-12", "pane-1")];
    const r = buildResourcesForUrlResponse(url, deps, rows);
    expect(r.agents[0]!.label).toBe("triage:BUTCHR-12");
  });
});

describe("buildResourcesForUrlResponse — jira-project (FACTORY-532, implementing FACTORY-531)", () => {
  const projectUrl = "https://acme.atlassian.net/jira/software/c/projects/BUTCHR/boards/1";

  function jiraProjectRow(ruleId: string, resourceId: string, pane: string): AgentDashboardRow {
    return {
      kind: "agent",
      resourceKey: encodeAgentKey({ resourceProvider: "jira-project", ruleId, resourceId }),
      tier: { kind: "project" },
      agentStatus: "working",
      pane,
      timeInStatus: floor,
      confirmedAt: new Date(0).toISOString(),
    };
  }

  test("a project/board URL resolves to a jira-project resource", () => {
    const r = buildResourcesForUrlResponse(projectUrl, deps, []);
    expect(r.resource).toEqual({ provider: "jira-project", id: "BUTCHR" });
  });

  test("the staffed jira-project agent is visible in `agents` — the whole point of the FACTORY-532 dashboard carve-out", () => {
    const rows: DashboardRow[] = [jiraProjectRow("gk", "BUTCHR", "pane-1")];
    const r = buildResourcesForUrlResponse(projectUrl, deps, rows);
    expect(r.agents).toEqual([{ agentKey: rows[0]!.resourceKey, ruleId: "gk", pane: "pane-1", live: true, label: "gk:BUTCHR" }]);
  });

  test("no jira-project agent staffed for this key: resource resolves but agents is [] — 'no agent running', not 'not a resource'", () => {
    const r = buildResourcesForUrlResponse(projectUrl, deps, []);
    expect(r.resource).toEqual({ provider: "jira-project", id: "BUTCHR" });
    expect(r.agents).toEqual([]);
  });

  test("a jira-work agent for the same project key does NOT satisfy the jira-project resource (providers never cross-match)", () => {
    const rows: DashboardRow[] = [agentRow("triage", "BUTCHR-12", "pane-1")];
    const r = buildResourcesForUrlResponse(projectUrl, deps, rows);
    expect(r.agents).toEqual([]);
  });
});
