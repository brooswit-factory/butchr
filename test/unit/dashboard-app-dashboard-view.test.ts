import { describe, expect, test } from "bun:test";
import {
  admissionView,
  buildDashboardViewModel,
  buildHeaderView,
  configBackLinkHref,
  displayResourceKey,
  floorView,
  freshnessView,
  NOT_APPLICABLE_LABEL,
  pageBannerView,
  safeClass,
  tierView,
  type AgentRowView,
  type DashboardHeaderInfo,
  type DashboardViewOpts,
  type WithheldRowView,
} from "../../dashboard-app/src/view-model/dashboard-view.js";
import type { AdmissionView, AgentDashboardRow, DashboardResponse, WithheldDashboardRow } from "../../src/agents/dashboard.js";
import type { StatusFloor } from "../../src/agents/status-floor.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function floor(partial: Partial<StatusFloor> & { sinceMs: number }): StatusFloor {
  return { since: new Date(partial.sinceMs).toISOString(), humanDuration: "n/a", exact: false, ...partial };
}

function admission(overrides: Partial<AdmissionView> = {}): AdmissionView {
  return { cap: 5, residency: 2, sentinels: 0, sources: [], ...overrides };
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

function withheldRow(overrides: Partial<WithheldDashboardRow> = {}): WithheldDashboardRow {
  return {
    kind: "withheld",
    resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "rule1", resourceId: "FACTORY-99" }),
    tier: { kind: "issue", issuetype: { checked: true, value: "Story" } },
    source: "issue-tier",
    waiting: floor({ sinceMs: NOW - 120_000, exact: true }),
    confirmedAt: new Date(NOW - 8_000).toISOString(),
    agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" },
    ...overrides,
  };
}

function checkedResponse(rows: DashboardResponse["rows"] = [], admissionView_ = admission()): DashboardResponse {
  return { checked: true, confirmedAt: new Date(NOW - 1_000).toISOString(), rows, admission: admissionView_ };
}

function declinedResponse(rows: DashboardResponse["rows"] = [], admissionView_ = admission()): DashboardResponse {
  return { checked: false, declinedAt: new Date(NOW - 30_000).toISOString(), rows, admission: admissionView_ };
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
    const f = floorView(anchor, NOW, "withheld");
    expect(f.title).toBe(`withheld since ${anchor.since}`);
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
  test("a withheld row gets no config back-link field at all (its view type has none)", () => {
    const row = withheldRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect("configHref" in vm.rows[0]!).toBe(false);
  });
});

describe("buildDashboardViewModel: withheld rows", () => {
  test("a withheld row carries its tier, floor, resourceHref, source, and the fixed not-applicable label text", () => {
    const row = withheldRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    const r = vm.rows[0] as WithheldRowView;
    expect(r.kind).toBe("withheld");
    expect(r.resourceKey).toBe(row.resourceKey);
    expect(r.tier).toEqual({ text: "Story", cnc: false });
    expect(r.notApplicableReason).toBe("no agent: withheld by the admission cap");
    expect(r.resourceHref).toBe(`/resource/${row.resourceKey}/open`);
    expect(r.source).toBe("issue-tier");
    expect(NOT_APPLICABLE_LABEL).toBe("no agent — n/a");
  });

  test("mutation 2: a withheld row with an unresolved issuetype carries BOTH the cnc tier marker AND its own not-applicable reason, distinctly", () => {
    const row = withheldRow({ tier: { kind: "issue", issuetype: { checked: false, declinedAt: "2026-01-01T00:00:00.000Z" } } });
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    const r = vm.rows[0] as WithheldRowView;
    expect(r.tier.cnc).toBe(true);
    expect(r.notApplicableReason).toBeTruthy();
  });

  test("withheld rows never render the full displayResourceKey decoding — the raw resourceKey is shown, same as dashboard-page.ts", () => {
    const row = withheldRow();
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as WithheldRowView).resourceKey).toBe(row.resourceKey);
  });

  test("a withheld row's own .na title is its own agentFields.reason, not a generic string", () => {
    const row = withheldRow({ agentFields: { applicable: false, reason: "a distinctive, specific reason" } });
    const vm = buildDashboardViewModel(checkedResponse([row]), BASE_OPTS);
    expect((vm.rows[0] as WithheldRowView).notApplicableReason).toBe("a distinctive, specific reason");
  });

  test("a withheld row's own source-scoped stale freshness (review gap #2): only the declined source's row goes stale", () => {
    const freshSourceRow = withheldRow({ source: "fresh-source", resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "r", resourceId: "A-1" }) });
    const declinedSourceRow = withheldRow({ source: "declined-source", resourceKey: encodeAgentKey({ resourceProvider: "jira-work", ruleId: "r", resourceId: "A-2" }) });
    const adm = admission({
      sources: [
        { source: "fresh-source", census: { checked: true, confirmedAt: new Date(NOW - 1_000).toISOString() } },
        { source: "declined-source", census: { checked: false, declinedAt: new Date(NOW - 1_000).toISOString(), reason: "boom" } },
      ],
    });
    const vm = buildDashboardViewModel(checkedResponse([freshSourceRow, declinedSourceRow], adm), BASE_OPTS);
    const [fresh, declined] = vm.rows as WithheldRowView[];
    expect(fresh!.freshness.stale).toBe(false);
    expect(declined!.freshness.stale).toBe(true);
  });

  test("a response mixing an agent row and a withheld row renders both, each with its own kind discriminator", () => {
    const vm = buildDashboardViewModel(checkedResponse([agentRow(), withheldRow()]), BASE_OPTS);
    expect(vm.rows.map((r) => r.kind)).toEqual(["agent", "withheld"]);
  });
});

describe("admissionView: mutation 3 — per-source independence, never smeared", () => {
  test("residency's could-not-check case (null) is never rendered as a known number", () => {
    const v = admissionView(admission({ residency: null }), NOW);
    expect(v.residencyKnown).toBe(false);
    expect(v.residencyText).toContain("could not check");
  });
  test("a known, non-null residency renders its real number", () => {
    const v = admissionView(admission({ residency: 7 }), NOW);
    expect(v.residencyKnown).toBe(true);
    expect(v.residencyText).toBe("7");
  });
  test("sentinels null renders the '?' could-not-check marker, distinct from a zero count", () => {
    const v = admissionView(admission({ sentinels: null }), NOW);
    expect(v.sentinelsKnown).toBe(false);
    expect(v.sentinelsText).toBe("?");
  });
  test("one checked source and one never-reported source render two independent entries, each carrying only its own state", () => {
    const v = admissionView(
      admission({
        sources: [
          { source: "ok-src", census: { checked: true, confirmedAt: new Date(NOW - 1_000).toISOString() } },
          { source: "bad-src", census: { checked: false, declinedAt: new Date(NOW - 1_000).toISOString(), reason: "untrusted" } },
        ],
      }),
      NOW,
    );
    expect(v.sources[0]).toMatchObject({ source: "ok-src", checked: true });
    expect(v.sources[0]!.text).not.toContain("untrusted");
    expect(v.sources[1]).toMatchObject({ source: "bad-src", checked: false });
    expect(v.sources[1]!.text).toContain("untrusted");
  });
});

describe("buildHeaderView — currency, never red", () => {
  const build = { sha: "abcdef0123456789", shaDirty: false, shaUnknownReason: null, version: "1.2.3" };
  const base = { ref: "origin/main", sha: "x", changedAt: null, changedAtUnknownReason: null, fetchedAt: null, fetchedAtUnknownReason: null };

  test("no currency sibling at all (older build): falls back to the build sha alone", () => {
    const header: DashboardHeaderInfo = { build };
    const v = buildHeaderView(header, NOW);
    expect(v.buildText).toContain("abcdef01");
    expect(v.currencyText).toBeNull();
  });

  test("current: renders 'current'", () => {
    const header: DashboardHeaderInfo = { build, currency: { checkedAt: new Date(NOW - 1000).toISOString(), verdict: { status: "current", base, dirtyUndeterminable: false } } };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).toContain("current");
  });

  test("stale with commitsAhead exactly 0: renders 'behind by N'", () => {
    const header: DashboardHeaderInfo = {
      build,
      currency: { checkedAt: new Date(NOW - 1000).toISOString(), verdict: { status: "stale", commitsBehind: 3, commitsAhead: 0, base, dirtyUndeterminable: false } },
    };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).toContain("behind by 3");
  });

  test("stale with commitsAhead null: NEVER 'behind' — renders diverged/undetermined instead", () => {
    const header: DashboardHeaderInfo = {
      build,
      currency: { checkedAt: new Date(NOW - 1000).toISOString(), verdict: { status: "stale", commitsBehind: 3, commitsAhead: null, base, dirtyUndeterminable: false } },
    };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).not.toContain("behind");
    expect(v.currencyText).toContain("diverged/undetermined");
  });

  test("stale with commitsAhead > 0: also diverged/undetermined, never 'behind'", () => {
    const header: DashboardHeaderInfo = {
      build,
      currency: { checkedAt: new Date(NOW - 1000).toISOString(), verdict: { status: "stale", commitsBehind: 3, commitsAhead: 2, base, dirtyUndeterminable: false } },
    };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).not.toContain("behind");
  });

  test("unknown verdict: could-not-check wording, and checkedAt:null reads 'never computed yet'", () => {
    const header: DashboardHeaderInfo = { build, currency: { checkedAt: null, verdict: { status: "unknown", reason: "no git" } } };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).toContain("could not determine — no git");
    expect(v.currencyText).toContain("never computed yet");
  });

  test("a known checkedAt renders 'checked <age> ago', never a bare 'checked'", () => {
    const header: DashboardHeaderInfo = { build, currency: { checkedAt: new Date(NOW - 60_000).toISOString(), verdict: { status: "current", base, dirtyUndeterminable: false } } };
    const v = buildHeaderView(header, NOW);
    expect(v.currencyText).toMatch(/checked .*\d.* ago/);
  });

  test("no build sha at all: renders 'build sha unknown', with the reason when given", () => {
    const v = buildHeaderView({ build: { sha: null, shaDirty: null, shaUnknownReason: "no provenance", version: "1.2.3" } }, NOW);
    expect(v.buildText).toBe("build sha unknown (no provenance)");
  });
});

describe("pageBannerView — mutation 1 (whole response) + mutation 5 (age source)", () => {
  test("a checked response's age comes from confirmedAt", () => {
    const response = checkedResponse();
    const v = pageBannerView(response, NOW);
    expect(v.checked).toBe(true);
    expect(v.text).toContain(response.checked ? response.confirmedAt : "");
  });
  test("a could-not-check page's age comes from declinedAt, never confirmedAt", () => {
    const response = declinedResponse();
    const v = pageBannerView(response, NOW);
    expect(v.checked).toBe(false);
    expect(v.text).toContain(!response.checked ? response.declinedAt : "");
  });
  test("a genuinely empty, checked fleet reads as a calm finding, not a failure", () => {
    const v = pageBannerView(checkedResponse([]), NOW);
    expect(v.emptyFindingText).toContain("this daemon runs no agents");
    expect(v.rowsCarriedNote).toBeNull();
  });
  test("a declined response with rows notes they are carried-forward and may be stale", () => {
    const v = pageBannerView(declinedResponse([agentRow()]), NOW);
    expect(v.rowsCarriedNote).toContain("carried forward");
  });
  test("a declined response with no rows notes that absence is NOT the same as 'runs no agents'", () => {
    const v = pageBannerView(declinedResponse([]), NOW);
    expect(v.rowsCarriedNote).toContain("NOT the same as");
  });
});

describe("buildDashboardViewModel: configurationsHref is always present (FACTORY-81 review fix)", () => {
  test("present with real agent rows", () => {
    expect(buildDashboardViewModel(checkedResponse([agentRow()]), BASE_OPTS).configurationsHref).toBe("/configurations");
  });
  test("present on a genuinely empty fleet", () => {
    expect(buildDashboardViewModel(checkedResponse([]), BASE_OPTS).configurationsHref).toBe("/configurations");
  });
  test("present even on a declined poll", () => {
    expect(buildDashboardViewModel(declinedResponse([]), BASE_OPTS).configurationsHref).toBe("/configurations");
  });
});
