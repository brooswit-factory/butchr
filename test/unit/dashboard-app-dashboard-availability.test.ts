import { describe, expect, test } from "bun:test";
import { dashboardRowCount } from "../../dashboard-app/src/view-model/dashboard-availability.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";

const admission: DashboardResponse["admission"] = { cap: 10, residency: 0, sentinels: 0, sources: [] };

describe("dashboardRowCount (pure) — FACTORY-614", () => {
  test("checked: true -> KNOWN row count, even when zero (a genuine empty fleet, not a failure)", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:00:00.000Z", rows: [], admission };
    expect(dashboardRowCount(response)).toEqual({ kind: "known", value: 0 });
  });

  test("checked: true with rows -> KNOWN with the real count", () => {
    const row = {
      kind: "agent" as const,
      resourceKey: "jira-work:r1:ABC-1",
      tier: { kind: "project" as const },
      agentStatus: "working",
      pane: "p1",
      timeInStatus: { exact: true, sinceMs: 0, since: "2026-01-01T00:00:00.000Z", humanDuration: "0s" },
      confirmedAt: "2026-01-01T00:00:00.000Z",
    };
    const response: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:00:00.000Z", rows: [row], admission };
    expect(dashboardRowCount(response)).toEqual({ kind: "known", value: 1 });
  });

  test("checked: false -> COULD NOT CHECK, never a count — mutation check: a mutation that reports a count anyway (e.g. `response.rows.length`) turns this red", () => {
    const response: DashboardResponse = { checked: false, declinedAt: "2026-01-01T00:00:00.000Z", rows: [], admission };
    const result = dashboardRowCount(response);
    expect(result.kind).toBe("could-not-check");
    expect(result.kind).not.toBe("known");
  });
});
