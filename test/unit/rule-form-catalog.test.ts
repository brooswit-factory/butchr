import { describe, expect, test } from "bun:test";
import { AGENT_HARNESSES, RULE_PERMISSION_MODES } from "../../src/rules/rules.js";
import { AGENT_EFFORTS } from "../../src/resources/power-scale.js";
import {
  CUSTOM_MODEL_PATTERN, RULE_FORM_CATALOG, customModelProblems, ruleFormCatalogEntry,
} from "../../src/rules/rule-form-catalog.js";

describe("RULE_FORM_CATALOG", () => {
  test("one entry per AGENT_HARNESSES member, in the same order", () => {
    expect(RULE_FORM_CATALOG.map((e) => e.harness)).toEqual([...AGENT_HARNESSES]);
  });

  test("every entry allows a custom model and offers the full permission-mode list", () => {
    for (const entry of RULE_FORM_CATALOG) {
      expect(entry.allowsCustomModel).toBe(true);
      expect(entry.permissionModes).toEqual(RULE_PERMISSION_MODES);
    }
  });

  test("claude/codex carry non-empty, de-duplicated model and effort lists; agy carries neither", () => {
    const claude = ruleFormCatalogEntry("claude");
    const codex = ruleFormCatalogEntry("codex");
    const agy = ruleFormCatalogEntry("agy");
    expect(claude.models.length).toBeGreaterThan(0);
    expect(new Set(claude.models).size).toBe(claude.models.length);
    expect(codex.models.length).toBeGreaterThan(0);
    expect(new Set(codex.models).size).toBe(codex.models.length);
    expect(claude.efforts).toEqual(AGENT_EFFORTS);
    expect(codex.efforts).toEqual(AGENT_EFFORTS);
    expect(agy.models).toEqual([]);
    expect(agy.efforts).toEqual([]);
  });

  test("every shipped model alias already satisfies CUSTOM_MODEL_PATTERN", () => {
    for (const entry of RULE_FORM_CATALOG) {
      for (const model of entry.models) expect(CUSTOM_MODEL_PATTERN.test(model)).toBe(true);
    }
  });

  test("ruleFormCatalogEntry is a plain lookup, not a copy of a mutated table", () => {
    expect(ruleFormCatalogEntry("claude")).toBe(RULE_FORM_CATALOG.find((e) => e.harness === "claude"));
  });
});

describe("customModelProblems", () => {
  test("accepts a shipped-looking alias and a dotted/namespaced custom id", () => {
    expect(customModelProblems("sonnet", "at")).toEqual([]);
    expect(customModelProblems("gpt-5.6-sol", "at")).toEqual([]);
    expect(customModelProblems("vendor:custom-model_v2.1", "at")).toEqual([]);
  });

  test("rejects empty, non-string, and leading-non-alphanumeric values", () => {
    expect(customModelProblems("", "at")).not.toEqual([]);
    expect(customModelProblems("   ", "at")).not.toEqual([]);
    expect(customModelProblems(42, "at")).not.toEqual([]);
    expect(customModelProblems(undefined, "at")).not.toEqual([]);
    expect(customModelProblems("-x", "at")).not.toEqual([]);
    expect(customModelProblems("--foo", "at")).not.toEqual([]);
  });

  test("rejects shell/argv-hostile characters and over-length values", () => {
    expect(customModelProblems("model; rm -rf /", "at")).not.toEqual([]);
    expect(customModelProblems("model$(whoami)", "at")).not.toEqual([]);
    expect(customModelProblems("model with space", "at")).not.toEqual([]);
    expect(customModelProblems("a".repeat(65), "at")).not.toEqual([]);
  });

  test("accepts exactly 64 characters", () => {
    expect(customModelProblems("a".repeat(64), "at")).toEqual([]);
  });

  test("error text names the field (`at`)", () => {
    const [problem] = customModelProblems("", "agentPreferences[0].model");
    expect(problem).toContain("agentPreferences[0].model");
  });
});
