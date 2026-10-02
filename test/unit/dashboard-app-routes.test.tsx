import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { DashboardRoute } from "../../dashboard-app/src/routes/DashboardRoute.js";
import { ConfigurationsRoute } from "../../dashboard-app/src/routes/ConfigurationsRoute.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";
import type { QueryAgentInventory } from "../../src/agents/query-agent-inventory.js";

withDom();
afterEach(cleanup);

function jsonFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("DashboardRoute — FACTORY-614", () => {
  test("shows the live row count from /dashboard once loaded — proves the data layer end to end, per this placeholder's whole purpose", async () => {
    const admission: DashboardResponse["admission"] = { cap: 1, residency: 0, sentinels: 0, sources: [] };
    const response: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:00:00.000Z", rows: [], admission };
    globalThis.fetch = jsonFetch(response);
    const { getByTestId } = render(<DashboardRoute />);
    await waitFor(() => expect(getByTestId("dashboard-row-count").textContent).toBe("0 row(s)"));
  });

  test("shows \"could not check\", never a stale count, when the daemon's own poll is checked: false", async () => {
    const admission: DashboardResponse["admission"] = { cap: 1, residency: 0, sentinels: 0, sources: [] };
    const response: DashboardResponse = { checked: false, declinedAt: "2026-01-01T00:00:00.000Z", rows: [], admission };
    globalThis.fetch = jsonFetch(response);
    const { getByTestId } = render(<DashboardRoute />);
    await waitFor(() => expect(getByTestId("dashboard-row-count").textContent).toBe("could not check"));
  });
});

describe("ConfigurationsRoute — FACTORY-614", () => {
  test("shows the live entry count from /config-inventory once loaded", async () => {
    const response: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    globalThis.fetch = jsonFetch(response);
    const { getByTestId } = render(<ConfigurationsRoute />);
    await waitFor(() => expect(getByTestId("config-entry-count").textContent).toBe("0 entries"));
  });
});
