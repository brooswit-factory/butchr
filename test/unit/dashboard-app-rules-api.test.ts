import { afterEach, describe, expect, test } from "bun:test";
import { createFixturesRulesApi, defaultRulesFixture, realRulesApi } from "../../dashboard-app/src/api/rules.js";

describe("createFixturesRulesApi — FACTORY-661", () => {
  test("listRules returns the provided initial state, not a shared default mutated by another instance", async () => {
    const custom = { rules: [], errors: [{ path: "/x/rules.json", message: "boom" }] };
    const api = createFixturesRulesApi({ initial: custom, latencyMs: 0 });
    const result = await api.listRules();
    expect(result).toEqual(custom);

    const other = createFixturesRulesApi({ latencyMs: 0 });
    const otherResult = await other.listRules();
    expect(otherResult).toEqual(defaultRulesFixture());
  });

  test("capabilities.write is true for fixtures", () => {
    expect(createFixturesRulesApi({ latencyMs: 0 }).capabilities.write).toBe(true);
  });

  test("applyToggle mutates only the targeted rule, leaving every other rule's own object untouched", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0 });
    const before = await api.listRules();
    const target = before.rules[0]!;
    const plan = await api.planToggle(target.id, !target.enabled);
    const updated = await api.applyToggle(target.id, !target.enabled, plan);
    expect(updated.enabled).toBe(!target.enabled);

    const after = await api.listRules();
    expect(after.rules.find((r) => r.id === target.id)!.enabled).toBe(!target.enabled);
    for (const r of after.rules) {
      if (r.id === target.id) continue;
      expect(r).toEqual(before.rules.find((b) => b.id === r.id)!);
    }
  });

  test("applyToggle on an unknown rule id rejects, never silently succeeding", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0 });
    const plan = await api.planToggle("does-not-exist", true);
    await expect(api.applyToggle("does-not-exist", true, plan)).rejects.toThrow(/unknown rule/);
  });

  test("failWith forces every call (list, preview, plan, apply) to reject with that message", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0, failWith: "simulated backend outage" });
    await expect(api.listRules()).rejects.toThrow("simulated backend outage");
    await expect(api.previewRule("factory-triage")).rejects.toThrow("simulated backend outage");
    await expect(api.planToggle("factory-triage", false)).rejects.toThrow("simulated backend outage");
  });

  test("previewRule returns the configured fixture for a given rule id, an empty preview otherwise", async () => {
    const api = createFixturesRulesApi({
      latencyMs: 0,
      previews: { "factory-triage": { ruleId: "factory-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] } },
    });
    expect(await api.previewRule("factory-triage")).toEqual({ ruleId: "factory-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] });
    expect(await api.previewRule("some-other-rule")).toEqual({ ruleId: "some-other-rule", total: 0, tickets: [] });
  });

  test("planToggle's default plan reports a stop when disabling and a spawn when enabling — the confirm-dialog trigger condition this ticket requires", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0 });
    const disablePlan = await api.planToggle("factory-triage", false);
    expect(disablePlan.stopped).toBeGreaterThan(0);
    const enablePlan = await api.planToggle("factory-triage", true);
    expect(enablePlan.spawned).toBeGreaterThan(0);
  });

  test("defaultRulesFixture exercises all three staffed tri-states (true/false/null)", () => {
    const states = new Set(defaultRulesFixture().rules.map((r) => r.staffed));
    expect(states.has(true)).toBe(true);
    expect(states.has(false)).toBe(true);
    expect(states.has(null)).toBe(true);
  });
});

describe("realRulesApi — FACTORY-661: never invents an endpoint", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listRules calls GET /api/rules, nothing else", async () => {
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response(JSON.stringify({ rules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await realRulesApi.listRules();
    expect(calledUrl).toBe("/api/rules");
    expect(calledInit?.method ?? "GET").toBe("GET");
  });

  test("previewRule calls GET /api/rules/:id/preview with the id encoded", async () => {
    let calledUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ ruleId: "a/b", total: 0, tickets: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await realRulesApi.previewRule("a/b");
    expect(calledUrl).toBe(`/api/rules/${encodeURIComponent("a/b")}/preview`);
  });

  test("planToggle POSTs to /api/rules/plan with the rule id and next-enabled state", async () => {
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response(JSON.stringify({ planHash: "h", spawned: 0, stopped: 0, restarted: 0, etag: "e" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await realRulesApi.planToggle("triage", false);
    expect(calledUrl).toBe("/api/rules/plan");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(String(calledInit?.body))).toEqual({ ruleId: "triage", enabled: false });
  });

  test("applyToggle refuses with no network call at all — no invented write endpoint", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;
    await expect(realRulesApi.applyToggle("triage", false, { planHash: "h", spawned: 0, stopped: 0, restarted: 0, etag: "e" })).rejects.toThrow(
      /write endpoint is not available/,
    );
    expect(fetchCalled).toBe(false);
  });

  test("capabilities.write is false — the Rules page must render the toggle disabled", () => {
    expect(realRulesApi.capabilities.write).toBe(false);
  });

  test("a non-2xx response from a real GET rejects rather than resolving with the error body", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(realRulesApi.listRules()).rejects.toThrow(/HTTP 500/);
  });
});
