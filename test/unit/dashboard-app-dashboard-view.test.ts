import { describe, expect, test } from "bun:test";
import {
  buildDashboardViewModel,
  buildHeaderView,
  configBackLinkHref,
  displayResourceKey,
  floorView,
  freshnessView,
  pageBannerView,
  safeClass,
  tierView,
  type AgentRowView,
  type DashboardHeaderInfo,
  type DashboardViewOpts,
} from "../../dashboard-app/src/view-model/dashboard-view.js";
import type { AgentDashboardRow, DashboardResponse } from "../../src/agents/dashboard.js";
import type { StatusFloor } from "../../src/agents/status-floor.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function floor(partial: Partial<StatusFloor> & { sinceMs: number }): StatusFloor {
  return { since: new Date(partial.sinceMs).toISOString(), humanDuration: "n/a", exact: false, ...partial };
}

const BASE_OPTS: DashboardViewOpts = {
  now: NOW,
  header: { build: null },
  terminalLinkHref: (pane) => `/agents/pane/${pane}/attach`,
  resourceLinkHref: (key) => `/resource/${key}/open`,
};

function agentRow(overrides: Partial<AgentDashboardRow> = {}): AgentDashboardRow {
  return {
    kind: "agent",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "rule1", resourceId: "FACTORY-68" }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
    agentStatus: "working",
    pane: "pane-1",
    timeInStatus: floor({ sinceMs: NOW - 60_000, exact: true }),
    confirmedAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

function checkedResponse(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: true, confirmedAt: new Date(NOW - 1_000).toISOString(), rows };
}

function declinedResponse(rows: DashboardResponse["rows"] = []): DashboardResponse {
  return { checked: false, declinedAt: new Date(NOW - 30_000).toISOString(), rows };
}

describe("tierView", () => {
  test("project tier renders 'project', never could-not-check", () => {
    expect(tierView({ kind: "project" })).toEqual({ text: "project", cnc: false });
  });
  test("a known issuetype renders plainly", () => {
    expect(tierView({ kind: "issue", issuetype: { checked: true, value: "Epic" } })).toEqual({ text: "Epic", cnc: false });
  });
  test("a declined issuetype renders could-not-check, never a guessed tier", () => {
    expect(tierView({ kind: "issue", issuetype: { checked: false, declinedAt: "2026-01-01T00:00:00.000Z" } })).toEqual({ text: "could not check", cnc: true });
  });
});

describe("displayResourceKey (FACTORY-408)", () => {
  test("an issue-tier agent key decodes to its bare resource id, never the full agent key", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "rule1", resourceId: "FACTORY-68" });
    expect(displayResourceKey(key)).toBe("FACTORY-68");
  });
  test("a query-level agent key renders '<provider>:<rule> (query)', never its own raw key", () => {
    const key = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "singleton-rule" });
    expect(displayResourceKey(key)).toBe("jira-work:singleton-rule (query)");
  });
  test("an undecodable key falls back to itself rather than throwing", () => {
    expect(displayResourceKey("not-a-real-key")).toBe("not-a-real-key");
  });
});

describe("floorView — mutation 4: exact marking + 'at least' prefix on the number itself", () => {
  test("a fresh (exact:false) floor carries an inexact note and is prefixed 'at least'", () => {
    const f = floorView(floor({ sinceMs: NOW - 60_000, exact: false }), NOW, 'in status "working"');
    expect(f.exact).toBe(false);
    expect(f.text.startsWith("at least ")).toBe(true);
    expect(f.inexactNote).toContain("since daemon start");
  });
  test("a witnessed (exact:true) transition carries NO 'at least' prefix and no inexact note", () => {
    const f = floorView(floor({ sinceMs: NOW - 60_000, exact: true }), NOW, 'in status "working"');
    expect(f.exact).toBe(true);
    expect(f.text.startsWith("at least ")).toBe(false);
    expect(f.inexactNote).toBeNull();
  });
  test("the duration is recomputed against the given `now`, not a frozen humanDuration", () => {
    const anchor = floor({ sinceMs: NOW - 60_000, exact: true, humanDuration: "BOGUS FROZEN VALUE" });
    const f = floorView(anchor, NOW + 60_000, "label");
    expect(f.text).not.toContain("BOGUS");
    expect(f.text).toContain("2m");
  });
  test("title carries the label and the anchor's own ISO timestamp", () => {
    const anchor = floor({ sinceMs: NOW - 60_000, exact: true });
    const f = floorView(anchor, NOW, 'in status "working"');
    expect(f.title).toBe(`in status "working" since ${anchor.since}`);
  });
});

describe("freshnessView — mutation 5 (row-level): stale never looks fresh", () => {
  test("a fresh, checked row renders '<verb> <age> ago', never STALE", () => {
    const f = freshnessView(new Date(NOW - 5_000).toISOString(), NOW, false, "confirmed");
    expect(f.stale).toBe(false);
    expect(f.text).toContain("confirmed");
    expect(f.text).not.toContain("STALE");
  });
  test("a stale row renders 'STALE — at least X old, as of <iso>', never calm 'confirmed' wording", () => {
    const iso = new Date(NOW - 5_000).toISOString();
    const f = freshnessView(iso, NOW, true, "confirmed");
    expect(f.stale).toBe(true);
    expect(f.text).toContain("STALE");
    expect(f.text).toContain(iso);
  });
});

describe("buildDashboardViewModel: agent rows", () => {
  test("an issue-tier row carries resourceKey, tier, agentStatus, pane, and both hrefs built from injected functions", () => {
    const row = agentRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    const r = vm.rows[0] as AgentRowView;
    expect(r.kind).toBe("agent");
    expect(r.resourceKey).toBe(row.resourceKey);
    expect(r.displayKey).toBe("FACTORY-68");
    expect(r.tier).toEqual({ text: "Task", cnc: false });
    expect(r.agentStatus).toBe("working");
    expect(r.statusClass).toBe("working");
    expect(r.pane).toBe("pane-1");
    expect(r.terminalHref).toBe("/agents/pane/pane-1/attach");
    expect(r.resourceHref).toBe(`/resource/${row.resourceKey}/open`);
  });

  test("a project-tier row renders tier 'project' — no issuetype to know or decline", () => {
    const row = agentRow({ resourceKey: encodeAgentKey({ resourceProvider: "jira-project", ruleId: "r", resourceId: "FACTORY" }), tier: { kind: "project" } });
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as AgentRowView).tier).toEqual({ text: "project", cnc: false });
  });

  test("statusClass is sanitized via safeClass, never trusting agentStatus to already be a CSS token", () => {
    expect(safeClass("Working!!")).toBe("working--");
    expect(safeClass("")).toBe("unknown");
  });

  test("an unavailable issuetype renders the cnc tier marker (mutation 1b), never plain known styling", () => {
    const row = agentRow({ tier: { kind: "issue", issuetype: { checked: false, declinedAt: "2026-01-01T00:00:00.000Z" } } });
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as AgentRowView).tier.cnc).toBe(true);
  });

  test("a checked response renders agent rows with a fresh (non-stale) freshness badge", () => {
    const row = agentRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as AgentRowView).freshness.stale).toBe(false);
  });

  test("mutation 1a: a declined (checked:false) response renders every carried-forward agent row STALE", () => {
    const row = agentRow();
    const vm = buildDashboardViewModel(declinedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as AgentRowView).freshness.stale).toBe(true);
  });

  test("mutation 8: every row's status comes from agentStatus, never any src/labels/* import — static guard", async () => {
    const src = await Bun.file(new URL("../../dashboard-app/src/view-model/dashboard-view.ts", import.meta.url)).text();
    expect(src).not.toMatch(/from ["'].*\/labels\//);
  });
});

describe("buildDashboardViewModel: the Configurations back-link (FACTORY-81)", () => {
  test("a rule-driven agent row gets a default /configurations#<anchor> href", () => {
    const row = agentRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as AgentRowView).configHref).toMatch(/^\/configurations#/);
  });
  test("a caller-supplied configLinkHref is used instead of the default", () => {
    const row = agentRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), { ...BASE_OPTS, configLinkHref: (anchor) => `/custom/${anchor}` });
    expect((vm.rows[0] as AgentRowView).configHref).toMatch(/^\/custom\//);
  });
  test("an undecodable resourceKey yields no config link at all (null), never a broken href", () => {
    expect(configBackLinkHref("not-a-real-key", {})).toBeNull();
  });
});
