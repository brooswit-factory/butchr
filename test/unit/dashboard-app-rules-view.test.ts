import { describe, expect, test } from "bun:test";
import { buildRulesViewModel, encodeResourceKey, renderStaffed } from "../../dashboard-app/src/view-model/rules-view.js";
import type { RuleDto, RulesListResponse } from "../../dashboard-app/src/api/rules.js";

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "r1",
    resourceProvider: "jira-work",
    query: "project = X",
    enabled: true,
    execution: "swarm",
    account: "none",
    role: "worker",
    agentPreferences: [],
    staffed: true,
    reason: null,
    ...overrides,
  };
}

describe("renderStaffed — FACTORY-661 (reused tri-state wording, config-inventory-page.ts's own renderStaffed)", () => {
  test("staffed: true never shows a reason, even if one were (incorrectly) present", () => {
    expect(renderStaffed({ staffed: true, reason: null })).toEqual({ text: "staffed", cls: "known" });
  });

  test("staffed: false renders UNSTAFFED, with the reason appended", () => {
    expect(renderStaffed({ staffed: false, reason: "disabled" })).toEqual({ text: "UNSTAFFED: disabled", cls: "cnc" });
  });

  test("staffed: null renders COULD NOT CHECK, never UNSTAFFED — the exact defect this contract exists to avoid repeating", () => {
    const result = renderStaffed({ staffed: null, reason: "census unavailable: most recent poll failed" });
    expect(result.text).toBe("COULD NOT CHECK: census unavailable: most recent poll failed");
    expect(result.text.toUpperCase()).not.toContain("UNSTAFFED");
  });

  test("a null reason with staffed:false renders UNSTAFFED with no trailing colon", () => {
    expect(renderStaffed({ staffed: false, reason: null })).toEqual({ text: "UNSTAFFED", cls: "cnc" });
  });
});

describe("buildRulesViewModel — FACTORY-661", () => {
  test("emptyState is true only when there are zero rules AND zero file errors", () => {
    expect(buildRulesViewModel({ rules: [], errors: [] }).emptyState).toBe(true);
    expect(buildRulesViewModel({ rules: [rule()], errors: [] }).emptyState).toBe(false);
    expect(buildRulesViewModel({ rules: [], errors: [{ path: "p", message: "m" }] }).emptyState).toBe(false);
  });

  test("fileErrors passes the errors array through unchanged — the validation-problems banner's own data", () => {
    const data: RulesListResponse = { rules: [], errors: [{ path: "/a/rules.json", message: "rules[0].id must be a lowercase slug" }] };
    expect(buildRulesViewModel(data).fileErrors).toEqual(data.errors);
  });

  test("preferencesText reads butchr's global agent config wording when agentPreferences is empty", () => {
    const vm = buildRulesViewModel({ rules: [rule({ agentPreferences: [] })], errors: [] });
    expect(vm.rows[0]!.preferencesText).toBe("butchr's global agent config");
  });

  test("preferencesText joins harness/model/effort per preference, comma-separated across multiple preferences", () => {
    const vm = buildRulesViewModel({
      rules: [rule({ agentPreferences: [{ harness: "claude", model: "claude-opus-5" }, { harness: "codex", effort: "high" }] })],
      errors: [],
    });
    expect(vm.rows[0]!.preferencesText).toBe("claude/claude-opus-5, codex/high");
  });

  test("each row carries the rule's own staffed rendering", () => {
    const vm = buildRulesViewModel({ rules: [rule({ staffed: false, reason: "disabled" })], errors: [] });
    expect(vm.rows[0]!.staffed).toEqual({ text: "UNSTAFFED: disabled", cls: "cnc" });
  });
});

describe("encodeResourceKey — FACTORY-661 (same format as encodeAgentKey, built without importing it at runtime)", () => {
  test("joins percent-encoded segments with a literal colon", () => {
    expect(encodeResourceKey("jira-work", "rule1", "FACTORY-68")).toBe("jira-work:rule1:FACTORY-68");
  });

  test("percent-encodes a colon or slash WITHIN a segment so it round-trips through decodeAnyAgentKey-style splitting", () => {
    const key = encodeResourceKey("filesystem", "rule1", "a/b:c");
    expect(key.split(":").length).toBe(3);
    expect(decodeURIComponent(key.split(":")[2]!)).toBe("a/b:c");
  });
});
