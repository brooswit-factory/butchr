import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { useHealth } from "../../dashboard-app/src/hooks/use-health.js";
import type { HealthStatus } from "../../src/daemon/health.js";

withDom();
afterEach(cleanup);

function Probe() {
  const state = useHealth();
  return <div data-testid="state">{JSON.stringify(state)}</div>;
}

function jsonResponse(body: unknown, status: number): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("useHealth — FACTORY-615", () => {
  test("fetches GET /health and resolves to loaded with the real response shape", async () => {
    const health: HealthStatus = { ok: true, components: [] };
    globalThis.fetch = jsonResponse(health, 200);
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    expect(JSON.parse(getByTestId("state").textContent ?? "{}").data).toEqual(health);
  });

  test("a 503 (unhealthy) response is NOT a transport failure — its body is parsed as the real health status, never discarded", async () => {
    const health: HealthStatus = { ok: false, components: [{ name: "c", ok: false, state: "stale", lastSuccessAt: null, staleForMs: 999 }] };
    globalThis.fetch = jsonResponse(health, 503);
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    expect(JSON.parse(getByTestId("state").textContent ?? "{}").data).toEqual(health);
  });

  test("a genuine network failure still moves this hook to error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"error"'));
    expect(getByTestId("state").textContent).toContain("network down");
  });
});
