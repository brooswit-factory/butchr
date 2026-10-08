import { describe, expect, test } from "bun:test";
import { AGENT_HARNESSES, RULE_PERMISSION_MODES } from "../../src/rules/agent-harness.js";
import { AGENT_HARNESSES as RULES_AGENT_HARNESSES, RULE_PERMISSION_MODES as RULES_RULE_PERMISSION_MODES } from "../../src/rules/rules.js";

describe("src/rules/agent-harness.ts", () => {
  test("AGENT_HARNESSES/RULE_PERMISSION_MODES are the expected constants", () => {
    expect(AGENT_HARNESSES).toEqual(["claude", "codex", "agy"]);
    expect(RULE_PERMISSION_MODES).toEqual(["default", "acceptEdits", "bypassPermissions", "plan", "auto"]);
  });

  // FACTORY-729: `rules.ts` re-exports these two constants unchanged — this
  // is what keeps every PRE-EXISTING importer of `rules.js` (which this
  // split must not break) working with the exact same values.
  test("rules.ts re-exports the SAME constant instances, not a copy", () => {
    expect(RULES_AGENT_HARNESSES).toBe(AGENT_HARNESSES);
    expect(RULES_RULE_PERMISSION_MODES).toBe(RULE_PERMISSION_MODES);
  });
});
