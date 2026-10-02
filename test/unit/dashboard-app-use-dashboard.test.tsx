import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { useDashboard } from "../../dashboard-app/src/hooks/use-dashboard.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";

withDom();
afterEach(cleanup);

function Probe() {
  const state = useDashboard();
  return <div data-testid="state">{JSON.stringify(state)}</div>;
}

const admission: DashboardResponse["admission"] = { cap: 5, residency: 0, sentinels: 0, sources: [] };
const okResponse: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:00:00.000Z", rows: [], admission };

describe("useDashboard — FACTORY-614", () => {
  test("fetches GET /dashboard (same origin, no new API) and resolves to loaded with the real response shape", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(okResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    expect(calls[0]).toBe("/dashboard");
    expect(JSON.parse(getByTestId("state").textContent ?? "{}").data).toEqual(okResponse);
  });

  test("a non-2xx response is a fetch failure, not a parsed body", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"error"'));
    expect(getByTestId("state").textContent).toContain("HTTP 500");
  });
});
