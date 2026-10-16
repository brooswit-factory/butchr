import { describe, expect, test } from "bun:test";
import { atlassianProviderStaffing } from "../../src/rules/atlassian-staffing.js";
import { parseRules } from "../../src/rules/rules.js";

const rules = parseRules({ rules: [
  { id: "triage", resourceProvider: "jira-work", query: "type = Bug", brief: "fix it" },
  { id: "ideas", resourceProvider: "jira-idea", query: "status = Open", brief: "look at it" },
  { id: "proj", resourceProvider: "jira-project", query: "{}", brief: "run it" },
  { id: "docs", resourceProvider: "confluence-page", query: JSON.stringify({ ancestor: "100" }), brief: "read it" },
  { id: "disabled-rule", resourceProvider: "jira-work", query: "type = Task", brief: "skip it", enabled: false },
  { id: "gh", resourceProvider: "github-issue", query: "type:Bug repo:acme/w", brief: "fix it" },
] });

describe("atlassianProviderStaffing (FACTORY-66)", () => {
  test("no enabled rules of the provider at all: run false, reason null, rules empty — nothing to report", () => {
    expect(atlassianProviderStaffing("jira-work", [], true, undefined)).toEqual({ run: false, rules: [], reason: null });
    // a DISABLED jira-work rule does not count as "enabled" — same as zero rules of that kind.
    const onlyDisabled = rules.filter((r) => r.id === "disabled-rule");
    expect(atlassianProviderStaffing("jira-work", onlyDisabled, true, undefined)).toEqual({ run: false, rules: [], reason: null });
  });

  test("enabled rules exist and Atlassian is configured: staffed, reason null", () => {
    const result = atlassianProviderStaffing("jira-work", rules, true, undefined);
    expect(result.run).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.rules.map((r) => r.id)).toEqual(["triage"]);
  });

  test("enabled rules exist but Atlassian is disabled/unconfigured/misconfigured: isolated failure naming the affected rule ids and the reason, never a throw", () => {
    for (const reason of [undefined, "Atlassian is disabled (BUTCHR_ATLASSIAN_ENABLED=false) — ...", "Atlassian is misconfigured: Atlassian token is empty — ..."]) {
      const result = atlassianProviderStaffing("jira-work", rules, false, reason);
      expect(result.run).toBe(false);
      expect(result.rules.map((r) => r.id)).toEqual(["triage"]);
      expect(result.reason).toContain("jira-work rules not staffed (triage)");
      expect(result.reason).toContain(reason ?? "Atlassian is not configured");
    }
  });

  test("each of the four Atlassian-backed providers is staffed independently of the others", () => {
    for (const provider of ["jira-work", "jira-idea", "jira-project", "confluence-page"] as const) {
      expect(atlassianProviderStaffing(provider, rules, true, undefined).run).toBe(true);
      expect(atlassianProviderStaffing(provider, rules, false, "off").run).toBe(false);
    }
  });

  test("an unrelated provider (github-issue) is never touched by this function's own enabled/rules filtering — it only ever looks at its own provider's rules", () => {
    const result = atlassianProviderStaffing("jira-work", rules, true, undefined);
    expect(result.rules.some((r) => r.resourceProvider === "github-issue")).toBe(false);
  });
});
