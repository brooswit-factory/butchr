import { describe, expect, test } from "bun:test";
import { buildRulesViewModel, encodeResourceKey, renderStaffed, resumeText } from "../../dashboard-app/src/view-model/rules-view.js";
import { FIRST_RULE_ID, PLACEHOLDER_QUERY, type RuleDto, type RulesListResponse } from "../../dashboard-app/src/api/rules.js";

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
    permissionMode: null,
    lizardMode: null,
    resumeOnRespawn: null,
    resumeContextCutoff: null,
    idlePokeMinutes: null,
    idlePokeMessage: null,
    idlePokeEnabled: true,
    staffed: true,
    reason: null,
    ...overrides,
  };
}

function response(overrides: Partial<RulesListResponse> = {}): RulesListResponse {
  return { rules: [], errors: [], sourceEtag: "e1", fileEtag: "e1", stale: false, ...overrides };
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

describe("buildRulesViewModel — FACTORY-661/FACTORY-663", () => {
  test("emptyState is true only when there are zero rules AND zero file errors", () => {
    expect(buildRulesViewModel(response()).emptyState).toBe(true);
    expect(buildRulesViewModel(response({ rules: [rule()] })).emptyState).toBe(false);
    expect(buildRulesViewModel(response({ errors: [{ path: "p", message: "m" }] })).emptyState).toBe(false);
  });

  test("fileErrors passes the errors array through unchanged — the validation-problems banner's own data", () => {
    const data = response({ errors: [{ path: "/a/rules.json", message: "rules[0].id must be a lowercase slug" }] });
    expect(buildRulesViewModel(data).fileErrors).toEqual(data.errors);
  });

  test("preferencesText reads butchr's global agent config wording when agentPreferences is empty", () => {
    const vm = buildRulesViewModel(response({ rules: [rule({ agentPreferences: [] })] }));
    expect(vm.rows[0]!.preferencesText).toBe("butchr's global agent config");
  });

  test("preferencesText joins harness/model/effort per preference, comma-separated across multiple preferences", () => {
    const vm = buildRulesViewModel(
      response({ rules: [rule({ agentPreferences: [{ harness: "claude", model: "claude-opus-5" }, { harness: "codex", effort: "high" }] })] }),
    );
    expect(vm.rows[0]!.preferencesText).toBe("claude/claude-opus-5, codex/high");
  });

  test("each row carries the rule's own staffed rendering", () => {
    const vm = buildRulesViewModel(response({ rules: [rule({ staffed: false, reason: "disabled" })] }));
    expect(vm.rows[0]!.staffed).toEqual({ text: "UNSTAFFED: disabled", cls: "cnc" });
  });

  // FACTORY-730: the route-level `ui-`-prefix write gate is retired, so this
  // view-model no longer computes a per-row `uiEditable` flag at all — every
  // row (a `ui-`-prefixed id or not) is carried through identically.
  test("FACTORY-730: rows carry every rule id unchanged, with no uiEditable gating", () => {
    const vm = buildRulesViewModel(response({ rules: [rule({ id: "factory-triage" }), rule({ id: FIRST_RULE_ID }), rule({ id: "ui-custom" })] }));
    expect(vm.rows.map((r) => r.rule.id)).toEqual(["factory-triage", FIRST_RULE_ID, "ui-custom"]);
    expect(vm.rows[0]).not.toHaveProperty("uiEditable");
  });

  test("sourceEtag and stale pass through verbatim — the ONLY values a write's ifMatch/disabled-state ever read", () => {
    const vm = buildRulesViewModel(response({ sourceEtag: "abc123", fileEtag: "def456", stale: true }));
    expect(vm.sourceEtag).toBe("abc123");
    expect(vm.stale).toBe(true);
  });

  test("firstRule is undefined when no ui-first-rule template is present", () => {
    const vm = buildRulesViewModel(response({ rules: [rule({ id: "some-other-rule" })] }));
    expect(vm.firstRule).toBeUndefined();
  });

  test("firstRule finds the ui-first-rule template by id, regardless of position", () => {
    const firstRule = rule({ id: FIRST_RULE_ID, query: PLACEHOLDER_QUERY, enabled: false });
    const vm = buildRulesViewModel(response({ rules: [rule({ id: "other" }), firstRule] }));
    expect(vm.firstRule).toEqual(firstRule);
  });
});

describe("resumeText — FACTORY-851 (Rule.resumeOnRespawn/Rule.resumeContextCutoff, display wording)", () => {
  test("both absent (null) renders resume: on (cutoff: default) — the schema's own absence meaning", () => {
    expect(resumeText({ resumeOnRespawn: null, resumeContextCutoff: null })).toBe("resume: on (cutoff: default)");
  });

  test("explicit true still renders on, same as absent", () => {
    expect(resumeText({ resumeOnRespawn: true, resumeContextCutoff: null })).toBe("resume: on (cutoff: default)");
  });

  test("explicit false renders off", () => {
    expect(resumeText({ resumeOnRespawn: false, resumeContextCutoff: null })).toBe("resume: off (cutoff: default)");
  });

  test("an explicit cutoff renders its literal value, never the server's own default number", () => {
    expect(resumeText({ resumeOnRespawn: null, resumeContextCutoff: 50000 })).toBe("resume: on (cutoff: 50000)");
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
