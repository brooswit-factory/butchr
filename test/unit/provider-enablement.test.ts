import { describe, expect, test } from "bun:test";
import { PROVIDER_ENABLED_ENV_VAR, parseProviderEnabledMap, applyProviderSwitch, type Staffing } from "../../src/rules/provider-enablement.js";
import type { ResourceProvider } from "../../src/rules/agent-key.js";
import { parseRules } from "../../src/rules/rules.js";

const ALL_PROVIDERS: ResourceProvider[] = ["jira-work", "jira-idea", "jira-project", "confluence-page", "github-issue", "github-pr", "zendesk-ticket", "filesystem", "jira-component"];

describe("PROVIDER_ENABLED_ENV_VAR (FACTORY-66 review round 2)", () => {
  test("exactly one distinctly-named env var per registered RESOURCE_PROVIDERS entry — no two providers share a switch", () => {
    expect(Object.keys(PROVIDER_ENABLED_ENV_VAR).sort()).toEqual([...ALL_PROVIDERS].sort());
    const names = Object.values(PROVIDER_ENABLED_ENV_VAR);
    expect(new Set(names).size).toBe(names.length); // all distinct
    for (const name of names) expect(name).toMatch(/^BUTCHR_PROVIDER_[A-Z_]+_ENABLED$/);
  });
});

describe("parseProviderEnabledMap", () => {
  test("unset env: every provider defaults to enabled — a host that sets none of these behaves exactly as before this ticket", () => {
    const map = parseProviderEnabledMap({});
    for (const p of ALL_PROVIDERS) expect(map[p]).toBe(true);
  });

  test("each provider's own switch is independent of every other — flipping one leaves the rest at their default", () => {
    const map = parseProviderEnabledMap({ [PROVIDER_ENABLED_ENV_VAR["confluence-page"]]: "false" });
    expect(map["confluence-page"]).toBe(false);
    for (const p of ALL_PROVIDERS) if (p !== "confluence-page") expect(map[p]).toBe(true);
  });

  test("the lenient falsy set (false/0/no/off, case-insensitive, trimmed) matches BUTCHR_ATLASSIAN_ENABLED's own convention", () => {
    for (const falsy of ["false", "FALSE", " False ", "0", "no", "NO", "off", "Off"]) {
      const map = parseProviderEnabledMap({ [PROVIDER_ENABLED_ENV_VAR["jira-work"]]: falsy });
      expect(map["jira-work"]).toBe(false);
    }
    for (const truthy of ["true", "1", "yes", "on", "garbage", ""]) {
      const map = parseProviderEnabledMap({ [PROVIDER_ENABLED_ENV_VAR["jira-work"]]: truthy });
      expect(map["jira-work"]).toBe(true);
    }
  });

  test("all eight switches can be off at once, independently from BUTCHR_ATLASSIAN_ENABLED (a different, coarser knob this module does not read)", () => {
    const env: Record<string, string> = {};
    for (const p of ALL_PROVIDERS) env[PROVIDER_ENABLED_ENV_VAR[p]] = "false";
    const map = parseProviderEnabledMap(env);
    for (const p of ALL_PROVIDERS) expect(map[p]).toBe(false);
  });
});

const rule = (id: string, resourceProvider: string, enabled = true) =>
  parseRules({ rules: [{ id, resourceProvider, query: resourceProvider === "jira-project" ? "{}" : resourceProvider === "confluence-page" ? JSON.stringify({ ancestor: "1" }) : "q", brief: "b", enabled }] })[0]!;

describe("applyProviderSwitch", () => {
  test("switch ON (the default): the input staffing is returned UNCHANGED (identity) — zero behavior change for a provider that never sets its switch", () => {
    const staffing: Staffing = { run: true, rules: [rule("a", "jira-work")] };
    expect(applyProviderSwitch("jira-work", staffing, true)).toBe(staffing); // same object reference
  });

  test("switch OFF: run becomes false and the reason names the exact env var, regardless of what the underlying staffing said", () => {
    const enabledStaffing: Staffing = { run: true, rules: [rule("a", "github-issue")] };
    const off = applyProviderSwitch("github-issue", enabledStaffing, false);
    expect(off.run).toBe(false);
    expect(off.reason).toContain("github-issue is disabled");
    expect(off.reason).toContain("BUTCHR_PROVIDER_GITHUB_ISSUE_ENABLED=false");
    expect(off.rules).toEqual(enabledStaffing.rules); // the rule list itself is preserved for reporting
  });

  test("switch OFF overrides an ALREADY-disabled staffing's own reason — the explicit operator decision wins over a credential/rule-count reason", () => {
    const misconfigured: Staffing = { run: false, rules: [rule("a", "jira-idea")], reason: "jira-idea rules not staffed (a): Atlassian is misconfigured" };
    const off = applyProviderSwitch("jira-idea", misconfigured, false);
    expect(off.run).toBe(false);
    expect(off.reason).toContain("jira-idea is disabled");
    expect(off.reason).not.toContain("misconfigured");
  });

  test("every one of the eight providers produces its own distinct, correctly-named disabled reason", () => {
    for (const p of ALL_PROVIDERS) {
      const off = applyProviderSwitch(p, { run: true, rules: [] }, false);
      expect(off.run).toBe(false);
      if (off.run) throw new Error("unreachable"); // narrows to DisabledStaffing, which always has a non-null `reason`
      expect(off.reason).toBe(`${p} is disabled (${PROVIDER_ENABLED_ENV_VAR[p]}=false)`);
    }
  });

  test("a disabled provider's switch does not affect an UNRELATED provider's own staffing (each call is independent)", () => {
    const a: Staffing = { run: true, rules: [rule("a", "jira-work")] };
    const b: Staffing = { run: true, rules: [rule("b", "zendesk-ticket")] };
    const aOff = applyProviderSwitch("jira-work", a, false);
    const bStillOn = applyProviderSwitch("zendesk-ticket", b, true);
    expect(aOff.run).toBe(false);
    expect(bStillOn.run).toBe(true);
    expect(bStillOn).toBe(b);
  });
});
