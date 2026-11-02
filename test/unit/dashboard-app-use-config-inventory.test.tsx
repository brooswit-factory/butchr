import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { useConfigInventory } from "../../dashboard-app/src/hooks/use-config-inventory.js";
import type { QueryAgentInventory } from "../../src/agents/query-agent-inventory.js";

withDom();
afterEach(cleanup);

function Probe() {
  const state = useConfigInventory();
  return <div data-testid="state">{JSON.stringify(state)}</div>;
}

const okResponse: QueryAgentInventory = { rules: [], sessionDefinitions: [], errors: [] };

describe("useConfigInventory — FACTORY-614", () => {
  test("fetches GET /config-inventory (same origin, no new API) and resolves to loaded with the real response shape", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(okResponse), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    expect(calls[0]).toBe("/config-inventory");
    expect(JSON.parse(getByTestId("state").textContent ?? "{}").data).toEqual(okResponse);
  });

  test("a rejected fetch (network error) is a failure, not a crash", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"error"'));
    expect(getByTestId("state").textContent).toContain("network down");
  });
});
