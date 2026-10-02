import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { ConfigurationsRoute } from "../../dashboard-app/src/routes/ConfigurationsRoute.js";
import type { QueryAgentInventory } from "../../src/agents/query-agent-inventory.js";

withDom();
afterEach(cleanup);

function jsonFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

// DashboardRoute's own real-dashboard behaviour (FACTORY-615) is covered by
// test/unit/dashboard-app-dashboard-route.test.tsx — its FACTORY-614
// placeholder-row-count assertions, which this route no longer renders,
// retired there.
describe("ConfigurationsRoute — FACTORY-614", () => {
  test("shows the live entry count from /config-inventory once loaded", async () => {
    const response: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };
    globalThis.fetch = jsonFetch(response);
    const { getByTestId } = render(<ConfigurationsRoute />);
    await waitFor(() => expect(getByTestId("config-entry-count").textContent).toBe("0 entries"));
  });
});
