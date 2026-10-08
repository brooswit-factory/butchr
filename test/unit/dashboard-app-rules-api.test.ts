import { afterEach, describe, expect, test } from "bun:test";
import {
  createFixturesRulesApi,
  defaultRulesFixture,
  realRulesApi,
  mapServerPreview,
  RateLimitError,
  FIRST_RULE_ID,
  PLACEHOLDER_QUERY,
  ENABLE_SCOPE_CEILING,
  type RuleDto,
  type RulesListResponse,
} from "../../dashboard-app/src/api/rules.js";

/**
 * A second `ui-`-prefixed rule (NOT the placeholder template) for write-flow
 * tests that need a writable rule with an already-real query —
 * `stale-github-prs`/`factory-triage`/`vip-zendesk` are deliberately NOT
 * `ui-`-prefixed (used instead to prove the 403 refusal).
 *
 * `execution: "singleton"` — FACTORY-685 (item 2) now requires confirm on
 * ANY enable of a `"swarm"` rule; these write-flow tests exist to exercise
 * OTHER gates (etag mismatch, stop/restart confirm, rate limiting, undo
 * scoping), not that one, which gets its own dedicated coverage.
 */
function uiDemoRule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "ui-demo",
    resourceProvider: "jira-work",
    query: "project = FACTORY",
    enabled: false,
    execution: "singleton",
    account: "none",
    role: "worker",
    agentPreferences: [],
    permissionMode: null,
    lizardMode: null,
    staffed: false,
    reason: "disabled",
    ...overrides,
  };
}

function withUiDemo(): RulesListResponse {
  const fixture = defaultRulesFixture();
  return { ...fixture, rules: [...fixture.rules, uiDemoRule()] };
}

describe("createFixturesRulesApi — FACTORY-661/FACTORY-663", () => {
  test("listRules returns the provided initial state, not a shared default mutated by another instance", async () => {
    const custom = { rules: [], errors: [{ path: "/x/rules.json", message: "boom" }] };
    const api = createFixturesRulesApi({ initial: custom, latencyMs: 0 });
    const result = await api.listRules();
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual(custom.errors);

    const other = createFixturesRulesApi({ latencyMs: 0 });
    const otherResult = await other.listRules();
    expect(otherResult).toEqual(defaultRulesFixture());
  });

  test("an initial literal without sourceEtag/fileEtag/stale (the pre-FACTORY-663 shape) still gets a usable default etag", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [], errors: [] }, latencyMs: 0 });
    const result = await api.listRules();
    expect(result.sourceEtag).toBe(result.fileEtag);
    expect(result.stale).toBe(false);
    expect(typeof result.sourceEtag).toBe("string");
    expect(result.sourceEtag.length).toBeGreaterThan(0);
  });

  test("capabilities.write is true for fixtures by default", () => {
    expect(createFixturesRulesApi({ latencyMs: 0 }).capabilities.write).toBe(true);
  });

  test("refreshCapabilities resolves sessionOk (default true) and mutates capabilities in place", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0, sessionOk: false });
    expect(api.capabilities.write).toBe(true); // unchanged until refreshCapabilities is called
    const result = await api.refreshCapabilities();
    expect(result.write).toBe(false);
    expect(api.capabilities.write).toBe(false);
  });

  test("defaultRulesFixture exercises all three staffed tri-states (true/false/null) and seeds the ui-first-rule template", () => {
    const fixture = defaultRulesFixture();
    const states = new Set(fixture.rules.map((r) => r.staffed));
    expect(states.has(true)).toBe(true);
    expect(states.has(false)).toBe(true);
    expect(states.has(null)).toBe(true);
    const firstRule = fixture.rules.find((r) => r.id === FIRST_RULE_ID);
    expect(firstRule).toBeTruthy();
    expect(firstRule!.query).toBe(PLACEHOLDER_QUERY);
    expect(firstRule!.enabled).toBe(false);
  });

  test("failWith forces every read call (list, preview, plan) to reject with that message", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0, failWith: "simulated backend outage" });
    await expect(api.listRules()).rejects.toThrow("simulated backend outage");
    await expect(api.previewRule("factory-triage")).rejects.toThrow("simulated backend outage");
    await expect(api.planRule("factory-triage", { enabled: false }, false)).rejects.toThrow("simulated backend outage");
  });

  test("previewRule returns the configured fixture for a given rule id, an empty preview otherwise", async () => {
    const api = createFixturesRulesApi({
      latencyMs: 0,
      previews: { "factory-triage": { ruleId: "factory-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] } },
    });
    expect(await api.previewRule("factory-triage")).toEqual({ ruleId: "factory-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] });
    expect(await api.previewRule("some-other-rule")).toEqual({ ruleId: "some-other-rule", total: 0, tickets: [] });
  });

  test("planRule's default plan reports a stop when disabling and a spawn when enabling — the confirm-dialog trigger condition this ticket requires", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0 });
    const disablePlan = await api.planRule("factory-triage", { enabled: false }, false);
    expect(disablePlan.stopped).toBeGreaterThan(0);
    const enablePlan = await api.planRule("stale-github-prs", { enabled: true }, false);
    expect(enablePlan.spawned).toBeGreaterThan(0);
  });

  describe("write flow — setEnabled/updateFields/undo", () => {
    test("setEnabled flips the rule and returns a backupId/etag that advances listRules' own sourceEtag", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0 });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: true }, false);
      const result = await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      expect(result.backupId).toBeTruthy();
      expect(result.changedIds).toEqual(["ui-demo"]);

      const after = await api.listRules();
      expect(after.sourceEtag).toBe(result.etag);
      expect(after.sourceEtag).not.toBe(before.sourceEtag);
      expect(after.rules.find((r) => r.id === "ui-demo")!.enabled).toBe(true);
      for (const r of after.rules) {
        if (r.id === "ui-demo") continue;
        expect(r).toEqual(before.rules.find((b) => b.id === r.id)!);
      }
    });

    test("setEnabled on an unknown rule id rejects, never silently succeeding", async () => {
      const api = createFixturesRulesApi({ latencyMs: 0 });
      await expect(api.setEnabled("does-not-exist", true, "e", "h", false)).rejects.toThrow(/unknown rule/);
    });

    test("setEnabled refuses a non-ui- rule id, matching the real server's own 403 wording", async () => {
      const api = createFixturesRulesApi({ latencyMs: 0 });
      const before = await api.listRules();
      await expect(api.setEnabled("factory-triage", false, before.sourceEtag, "h", false)).rejects.toThrow(/does not carry the "ui-" prefix/);
    });

    test("planRule itself refuses enabling ui-first-rule while its query is still the placeholder, matching the real server's own check order (planRuleWrite refuses before any confirm/scope logic)", async () => {
      // FACTORY-685: the fixture now mirrors the real server's own
      // `planRuleWrite`, which refuses this BEFORE computing confirm/scope
      // at all — updated deliberately (this used to only throw from
      // `setEnabled`, which was itself a gap against the real server's
      // actual behavior, not a faithful simulation of it).
      const api = createFixturesRulesApi({ latencyMs: 0 });
      await expect(api.planRule(FIRST_RULE_ID, { enabled: true }, false)).rejects.toThrow(
        `rule "${FIRST_RULE_ID}" cannot be enabled while its query is still the placeholder — edit the query first`,
      );
    });

    test("setEnabled ALSO refuses enabling ui-first-rule while its query is still the placeholder (the authoritative, locked recheck), given a hand-built planHash", async () => {
      const api = createFixturesRulesApi({ latencyMs: 0 });
      const before = await api.listRules();
      await expect(api.setEnabled(FIRST_RULE_ID, true, before.sourceEtag, "irrelevant-hash", false)).rejects.toThrow(
        `rule "${FIRST_RULE_ID}" cannot be enabled while its query is still the placeholder — edit the query first`,
      );
    });

    test("setEnabled refuses a stale ifMatch (etag mismatch)", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0 });
      await expect(api.setEnabled("ui-demo", true, "stale-etag", "h", false)).rejects.toThrow(/etag mismatch/);
    });

    test("updateFields on ui-first-rule's query succeeds while disabled, with zero blast radius (no confirm needed)", async () => {
      const api = createFixturesRulesApi({ latencyMs: 0 });
      const before = await api.listRules();
      const plan = await api.planRule(FIRST_RULE_ID, { query: "key = XYZ-1" }, false);
      expect(plan.stopped).toBe(0);
      expect(plan.restarted).toBe(0);
      const result = await api.updateFields(FIRST_RULE_ID, { query: "key = XYZ-1" }, before.sourceEtag, plan.planHash, false);
      expect(result.changedIds).toEqual([FIRST_RULE_ID]);
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === FIRST_RULE_ID)!.query).toBe("key = XYZ-1");
    });

    test("FACTORY-729: setting permissionMode: bypassPermissions without confirm is refused; confirm: true succeeds and merges harness into agentPreferences", async () => {
      const withPreference: RulesListResponse = {
        ...defaultRulesFixture(),
        rules: [...defaultRulesFixture().rules, uiDemoRule({ id: "ui-with-pref", agentPreferences: [{ harness: "claude", model: "sonnet" }] })],
      };
      const api = createFixturesRulesApi({ initial: withPreference, latencyMs: 0 });
      const before = await api.listRules();
      const refusedPlan = await api.planRule("ui-with-pref", { permissionMode: "bypassPermissions" }, false);
      expect(refusedPlan.requiresConfirm).toBe(true);
      expect(refusedPlan.confirmReason).toBe("risky-permission");
      await expect(api.updateFields("ui-with-pref", { permissionMode: "bypassPermissions" }, before.sourceEtag, refusedPlan.planHash, false)).rejects.toThrow(/never a default/);

      const confirmedPlan = await api.planRule("ui-with-pref", { permissionMode: "bypassPermissions", agentPreferences: [{ harness: "codex" }] }, true);
      const result = await api.updateFields("ui-with-pref", { permissionMode: "bypassPermissions", agentPreferences: [{ harness: "codex" }] }, before.sourceEtag, confirmedPlan.planHash, true);
      expect(result.changedIds).toEqual(["ui-with-pref"]);
      const after = await api.listRules();
      const updated = after.rules.find((r) => r.id === "ui-with-pref")!;
      expect(updated.permissionMode).toBe("bypassPermissions");
      expect(updated.agentPreferences[0]!.harness).toBe("codex");
      expect(updated.agentPreferences[0]!.model).toBe("sonnet");
    });

    test("FACTORY-729: lizardMode: true without confirm is refused; lizardMode: false needs no confirm", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0 });
      const before = await api.listRules();
      const riskyPlan = await api.planRule("ui-demo", { lizardMode: true }, false);
      expect(riskyPlan.requiresConfirm).toBe(true);
      await expect(api.updateFields("ui-demo", { lizardMode: true }, before.sourceEtag, riskyPlan.planHash, false)).rejects.toThrow(/never a default/);

      const safePlan = await api.planRule("ui-demo", { lizardMode: false }, false);
      expect(safePlan.requiresConfirm).toBe(false);
      const result = await api.updateFields("ui-demo", { lizardMode: false }, before.sourceEtag, safePlan.planHash, false);
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "ui-demo")!.lizardMode).toBe(false);
      expect(result.changedIds).toEqual(["ui-demo"]);
    });

    test("enabling over the scope ceiling without confirm is refused with the server's own wording; confirm:true succeeds", async () => {
      const seeded = defaultRulesFixture();
      const idx = seeded.rules.findIndex((r) => r.id === FIRST_RULE_ID);
      // past the placeholder AND execution: "singleton" — isolates the
      // ceiling gate from FACTORY-685's own swarm-enable gate (which, for a
      // swarm rule, fires first and unconditionally on ANY enable without
      // confirm — see that item's own dedicated coverage), so this test's
      // original point (the ceiling refusal specifically) still holds.
      seeded.rules[idx] = { ...seeded.rules[idx]!, query: "project = FACTORY", execution: "singleton" };
      const api = createFixturesRulesApi({
        initial: seeded,
        latencyMs: 0,
        plans: { [FIRST_RULE_ID]: { planHash: "plan-1", spawned: 1, stopped: 0, restarted: 0, etag: "e", scopeCount: ENABLE_SCOPE_CEILING + 5, requiresConfirm: true, confirmReason: "scope-ceiling" } },
      });
      const before = await api.listRules();
      const plan = await api.planRule(FIRST_RULE_ID, { enabled: true }, false);
      expect(plan.scopeCount).toBeGreaterThan(ENABLE_SCOPE_CEILING);
      await expect(api.setEnabled(FIRST_RULE_ID, true, before.sourceEtag, plan.planHash, false)).rejects.toThrow(/above the 25-ticket confirm ceiling/);
      const result = await api.setEnabled(FIRST_RULE_ID, true, before.sourceEtag, plan.planHash, true);
      expect(result.changedIds).toEqual([FIRST_RULE_ID]);
    });

    test("a stop/restart without confirm is refused with the server's own wording; confirm:true succeeds", async () => {
      const seeded = withUiDemo();
      const idx = seeded.rules.findIndex((r) => r.id === "ui-demo");
      seeded.rules[idx] = { ...seeded.rules[idx]!, enabled: true }; // already running, so disabling it stops an agent
      const api = createFixturesRulesApi({ initial: seeded, latencyMs: 0 });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: false }, false);
      expect(plan.stopped).toBeGreaterThan(0);
      await expect(api.setEnabled("ui-demo", false, before.sourceEtag, plan.planHash, false)).rejects.toThrow(/retry with confirm: true to proceed/);
      const result = await api.setEnabled("ui-demo", false, before.sourceEtag, plan.planHash, true);
      expect(result.changedIds).toEqual(["ui-demo"]);
    });

    test("nextWriteError is a ONE-SHOT refusal: it fires on the next write, then clears, matching a real stale-lock 409", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0, nextWriteError: 'the rules file is locked by a stale lock — remove "/tmp/rules.json.lock" and retry' });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: true }, false);
      await expect(api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false)).rejects.toThrow(/stale lock/);
      // Second attempt (same inputs) succeeds — the one-shot error already fired.
      const result = await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      expect(result.changedIds).toEqual(["ui-demo"]);
    });

    test("nextRateLimit is a ONE-SHOT RateLimitError on the next write, then clears — carrying retryAfterSeconds through, not just mashed into the message", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0, nextRateLimit: { retryAfterSeconds: 6 } });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: true }, false);
      let caught: unknown;
      try {
        await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RateLimitError);
      expect((caught as RateLimitError).retryAfterSeconds).toBe(6);
      // Second attempt (same inputs) succeeds — the one-shot rate limit already fired.
      const result = await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      expect(result.changedIds).toEqual(["ui-demo"]);
    });

    test("nextRateLimit without retryAfterSeconds still throws a RateLimitError, with retryAfterSeconds undefined (no header simulated)", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0, nextRateLimit: {} });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: true }, false);
      let caught: unknown;
      try {
        await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RateLimitError);
      expect((caught as RateLimitError).retryAfterSeconds).toBeUndefined();
    });

    test("undo restores the most recent UI write's own backup and clears it (a second undo is refused)", async () => {
      const api = createFixturesRulesApi({ initial: withUiDemo(), latencyMs: 0 });
      const before = await api.listRules();
      const plan = await api.planRule("ui-demo", { enabled: true }, false);
      const write = await api.setEnabled("ui-demo", true, before.sourceEtag, plan.planHash, false);
      expect(write.backupId).toBeTruthy();

      const undone = await api.undo(write.backupId!);
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "ui-demo")!.enabled).toBe(false);
      expect(undone.etag).toBe(after.sourceEtag);

      await expect(api.undo(write.backupId!)).rejects.toThrow(/most recent web-UI write's own backup/);
    });

    test("undo refuses a backup id that isn't the most recent UI write's own", async () => {
      const api = createFixturesRulesApi({ latencyMs: 0 });
      await expect(api.undo("some-other-backup")).rejects.toThrow(/most recent web-UI write's own backup/);
    });

    test("undo refuses once the file has moved on since that write (a hand edit in between)", async () => {
      const fixture = withUiDemo();
      const api = createFixturesRulesApi({ initial: { ...fixture, rules: [...fixture.rules, uiDemoRule({ id: "ui-demo-2", enabled: true })] }, latencyMs: 0 });
      const before = await api.listRules();
      const plan1 = await api.planRule("ui-demo", { enabled: true }, false);
      const write1 = await api.setEnabled("ui-demo", true, before.sourceEtag, plan1.planHash, false);

      const afterFirst = await api.listRules();
      const plan2 = await api.planRule("ui-demo-2", { enabled: false }, false);
      await api.setEnabled("ui-demo-2", false, afterFirst.sourceEtag, plan2.planHash, true);

      await expect(api.undo(write1.backupId!)).rejects.toThrow(/most recent web-UI write's own backup/);
    });
  });
});

describe("realRulesApi — FACTORY-661/FACTORY-663: never invents an endpoint", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listRules calls GET /api/rules, mapping the server's real shape onto this module's own stable one", async () => {
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response(
        JSON.stringify({
          path: "/x/rules.json",
          mtime: null,
          sourceEtag: "s1",
          fileEtag: "f1",
          stale: true,
          valid: false,
          problems: ["boom"],
          rules: [
            {
              id: "r1",
              resourceProvider: "jira-work",
              query: "q",
              enabled: true,
              execution: "swarm",
              account: "none",
              role: "worker",
              agentPreferences: [],
              linkedEventing: false,
              mcpServerNames: [],
              permissionMode: "acceptEdits",
              lizardMode: true,
              briefExcerpt: "",
              staffed: false,
              whyUnstaffed: "disabled",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await realRulesApi.listRules();
    expect(calledUrl).toBe("/api/rules");
    expect(calledInit?.method ?? "GET").toBe("GET");
    expect(result.sourceEtag).toBe("s1");
    expect(result.fileEtag).toBe("f1");
    expect(result.stale).toBe(true);
    expect(result.errors).toEqual([{ path: "/x/rules.json", message: "boom" }]);
    expect(result.rules).toEqual([{ id: "r1", resourceProvider: "jira-work", query: "q", enabled: true, execution: "swarm", account: "none", role: "worker", agentPreferences: [], permissionMode: "acceptEdits", lizardMode: true, staffed: false, reason: "disabled" }]);
  });

  test("getCatalog calls GET /api/rules/catalog and returns the harnesses array verbatim", async () => {
    let calledUrl: string | undefined;
    const fakeHarnesses = [{ harness: "claude", models: ["sonnet"], allowsCustomModel: true, efforts: ["low"], permissionModes: ["default"] }];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ harnesses: fakeHarnesses }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await realRulesApi.getCatalog();
    expect(calledUrl).toBe("/api/rules/catalog");
    expect(result).toEqual(fakeHarnesses);
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

  test("planRule POSTs {id, patch, confirm} to /api/rules/plan, no ifMatch", async () => {
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
    await realRulesApi.planRule("triage", { enabled: false }, true);
    expect(calledUrl).toBe("/api/rules/plan");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(String(calledInit?.body))).toEqual({ id: "triage", patch: { enabled: false }, confirm: true });
  });

  test("planRule reads the in-flight contract's own `scope` field as scopeCount when the server hasn't renamed it yet", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ planHash: "h", spawned: 1, stopped: 0, restarted: 0, etag: "e", scope: 7 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const plan = await realRulesApi.planRule("triage", { enabled: true }, false);
    expect(plan.scopeCount).toBe(7);
  });

  test("setEnabled POSTs to /api/rules/:id/enabled with a flat body, and the CSRF header fetched from /api/session", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ backupId: "b1", etag: "e2", changedIds: ["triage"] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await realRulesApi.setEnabled("triage", true, "e1", "hash1", false);
    expect(result).toEqual({ backupId: "b1", etag: "e2", changedIds: ["triage"] });
    const writeCall = calls.find((c) => c.url === "/api/rules/triage/enabled")!;
    expect(writeCall.init?.method).toBe("POST");
    expect(JSON.parse(String(writeCall.init?.body))).toEqual({ enabled: true, ifMatch: "e1", planHash: "hash1", confirm: false });
    expect((writeCall.init?.headers as Record<string, string>)["x-butchr-csrf"]).toBe("tok");
  });

  test("updateFields PUTs a flat body (no nested patch) to /api/rules/:id", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ backupId: null, etag: "e2", changedIds: ["triage"] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await realRulesApi.updateFields("triage", { query: "key = X-1" }, "e1", "hash1", true);
    const writeCall = calls.find((c) => c.url === "/api/rules/triage")!;
    expect(writeCall.init?.method).toBe("PUT");
    expect(JSON.parse(String(writeCall.init?.body))).toEqual({ query: "key = X-1", ifMatch: "e1", planHash: "hash1", confirm: true });
  });

  test("undo POSTs to /api/undo/:backupId with the id encoded", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ backupId: null, etag: "e3", changedIds: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await realRulesApi.undo("a/b");
    expect(calls).toContain(`/api/undo/${encodeURIComponent("a/b")}`);
  });

  test("capabilities.write starts false — the Rules page must render every write control disabled until refreshCapabilities succeeds", () => {
    expect(realRulesApi.capabilities.write).toBe(false);
  });

  test("refreshCapabilities flips capabilities.write true on a successful GET /api/session, false on a 404 (today's main)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ csrfToken: "tok" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    let result = await realRulesApi.refreshCapabilities();
    expect(result.write).toBe(true);
    expect(realRulesApi.capabilities.write).toBe(true);

    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    result = await realRulesApi.refreshCapabilities();
    expect(result.write).toBe(false);
    expect(realRulesApi.capabilities.write).toBe(false);
  });

  test("a non-2xx response from a real GET rejects with the error body's own message, verbatim", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "peer uid check failed" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(realRulesApi.listRules()).rejects.toThrow("peer uid check failed");
  });

  test("a non-2xx response with a non-JSON body falls back to a generic HTTP message", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(realRulesApi.listRules()).rejects.toThrow(/HTTP 500/);
  });

  // FACTORY-678 (landing soon, not yet merged): a server-side write rate
  // limit will return 429 with a `Retry-After` header across the write
  // routes. Nothing emits this today, so these tests simulate the response
  // shape directly against `realRulesApi` — forward-compatible handling,
  // not an end-to-end check.
  test("a 429 with a Retry-After header throws a RateLimitError carrying the parsed retryAfterSeconds, same {error} message as every other refusal", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "too many writes — slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "6" },
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await realRulesApi.listRules();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).message).toBe("too many writes — slow down");
    expect((caught as RateLimitError).retryAfterSeconds).toBe(6);
  });

  test("a 429 with no Retry-After header still throws a RateLimitError, with retryAfterSeconds undefined — the fallback path", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "too many writes — slow down" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await realRulesApi.listRules();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfterSeconds).toBeUndefined();
    expect((caught as RateLimitError).message).toBe("too many writes — slow down");
  });

  test("non-429 error paths are unaffected: a 403 still throws a plain Error, not a RateLimitError", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "peer uid check failed" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await realRulesApi.listRules();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RateLimitError);
    expect((caught as Error).message).toBe("peer uid check failed");
  });
});

describe("mapServerPreview — FACTORY-686: the REAL server preview shape (found by a real-browser pass)", () => {
  test("maps the server's {ok, keys, total, cap, warning} body to {ruleId, total, tickets:[{key}]}", () => {
    expect(mapServerPreview("ui-first-rule", { ok: true, keys: ["P-1", "P-2", "P-3"], total: 3, cap: 50, warning: null })).toEqual({
      ruleId: "ui-first-rule",
      total: 3,
      tickets: [{ key: "P-1" }, { key: "P-2" }, { key: "P-3" }],
    });
  });
  test("total above the capped key list is preserved (the server caps keys, not the count)", () => {
    const r = mapServerPreview("r", { ok: true, keys: ["A-1", "A-2"], total: 40, cap: 2, warning: "cap" });
    expect(r.total).toBe(40);
    expect(r.tickets.length).toBe(2);
  });
  test("still tolerates the older {tickets:[{key}]} shape", () => {
    expect(mapServerPreview("r", { total: 1, tickets: [{ key: "Z-9" }] }).tickets).toEqual([{ key: "Z-9" }]);
  });
  test("an ok:false body is refused with the server's message, never rendered as an empty list", () => {
    expect(() => mapServerPreview("r", { ok: false, status: 502, error: "jira unavailable" })).toThrow("jira unavailable");
  });
  test("garbage never throws a TypeError at render time: it maps to an empty, well-formed response", () => {
    for (const raw of [undefined, null, {}, [], "x", { keys: "no" }, { keys: [1, null] }]) {
      const r = mapServerPreview("r", raw);
      expect(Array.isArray(r.tickets)).toBe(true);
      expect(r.tickets.length).toBe(0);
    }
  });
});
