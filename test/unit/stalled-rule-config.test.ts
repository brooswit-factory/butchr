import { expect, test } from "bun:test";
import { parseRules } from "../../src/rules/rules.js";
import { createStalledCheck } from "../../src/agents/stalled.js";
import { stalledMinutesForIssues, type RuleMatch } from "../../src/rules/resource-type.js";
import { pinnedActiveMinutesFor } from "../../src/rules/jira-project-type.js";
import { applyRuleFieldPatch } from "../../src/rules/rules-write-apply.js";
import { validateRuleFieldPatch } from "../../src/rules/rules-write-registry.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";

const raw = { id: "custom-query", resourceProvider: "jira-work", query: "project = DEMO", brief: "do work" };
const rule = (extra: Record<string, unknown> = {}) => parseRules({ rules: [{ ...raw, ...extra }] })[0]!;

test("stalledMinutes is optional, independent of idlePokeMinutes, and round-trips/reset through config patches", () => {
  expect(rule().stalledMinutes).toBeUndefined();
  expect(rule({ stalledMinutes: 45, idlePokeMinutes: 5 }).stalledMinutes).toBe(45);
  expect(validateRuleFieldPatch({ stalledMinutes: 45 })).toEqual({ ok: true, patch: { stalledMinutes: 45 } });
  const text = JSON.stringify({ rules: [raw, { ...raw, id: "other" }] });
  const edited = applyRuleFieldPatch(text, raw.id, { stalledMinutes: 45 });
  expect(parseRules(JSON.parse(edited))[0]!.stalledMinutes).toBe(45);
  expect(parseRules(JSON.parse(edited))[1]!.stalledMinutes).toBeUndefined();
  expect(validateRuleFieldPatch({ stalledMinutes: null }).ok).toBe(true);
  const reset = applyRuleFieldPatch(edited, raw.id, { stalledMinutes: null });
  expect(parseRules(JSON.parse(reset))[0]!.stalledMinutes).toBeUndefined();
});

test.each([0, -1, NaN, Infinity, "30", true, null])("invalid stored stalledMinutes %j is rejected", value => {
  expect(() => rule({ stalledMinutes: value })).toThrow("stalledMinutes");
  if (value !== null) expect(validateRuleFieldPatch({ stalledMinutes: value }).ok).toBe(false);
});

test("query-level issue agents without a stalled detector reject an inert override", () => {
  expect(() => rule({ execution: "singleton", stalledMinutes: 2560 })).toThrow("existing stalled detector");
  expect(() => rule({ execution: "persistent", stalledMinutes: 2560 })).toThrow("existing stalled detector");
});

test.each([10, 40, 160, 640, 2560])("manual duration %d is preserved without deriving a role or hierarchy", minutes => {
  expect(rule({ stalledMinutes: minutes }).stalledMinutes).toBe(minutes);
});

test("manual thresholds change detection, not streak tracking or the default for other tickets", async () => {
  let now = 0;
  let override: number | undefined = 30;
  const check = createStalledCheck({ now: () => now, minutes: 10, minutesFor: key => key === "CUSTOM-1" ? override : undefined, comments: async () => [] });
  for (const key of ["CUSTOM-1", "LEAF-1"]) expect(await check.check(key, "idle")).toBe(false);
  now = 10 * 60_000;
  expect(await check.check("LEAF-1", "idle")).toBe(true);
  expect(await check.check("CUSTOM-1", "idle")).toBe(false);
  expect(check.thresholdMinutes?.("CUSTOM-1")).toBe(30);
  now = 30 * 60_000;
  expect(await check.check("CUSTOM-1", "idle")).toBe(true);
  expect(await check.check("CUSTOM-1", "working")).toBe(false);
  expect(await check.check("CUSTOM-1", "idle")).toBe(false);
  override = undefined;
  now = 40 * 60_000;
  expect(await check.check("CUSTOM-1", "idle")).toBe(true);
  expect(check.thresholdMinutes?.("CUSTOM-1")).toBe(10);
});

test("overlapping issue queries use the longest explicit threshold; disabled/removed rules leave no override", () => {
  const unit = (extra: Record<string, unknown>): ExecutionUnit<RuleMatch> => {
    const r = rule(extra);
    return { kind: "resource", match: { rule: r, agentKey: "jira-work:custom-query:DEMO-1", issue: { key: "DEMO-1", issuetype: "Arbitrary type", status: "In Progress", summary: "s", updated: "t", labels: [], parent: null, assignee: null } } };
  };
  expect(stalledMinutesForIssues([unit({ stalledMinutes: 20 }), unit({ stalledMinutes: 60 }), unit({ stalledMinutes: 100, enabled: false }), unit({ idlePokeMinutes: 1 })]).get("DEMO-1")).toBe(60);
  expect(stalledMinutesForIssues([unit({})]).size).toBe(0);
  expect(stalledMinutesForIssues([]).size).toBe(0);
});

test("project managers get their explicit threshold, with the legacy project override retained only as fallback", () => {
  const matches = [
    { agentKey: "manager", rule: rule({ resourceProvider: "jira-project", query: "{}", stalledMinutes: 90, idlePokeMinutes: 5 }), project: { id: "1", key: "DEMO", name: "Demo" } },
    { agentKey: "legacy", rule: rule({ resourceProvider: "jira-project", query: "{}", idlePokeMinutes: 25 }), project: { id: "1", key: "DEMO", name: "Demo" } },
  ];
  expect([...pinnedActiveMinutesFor(matches)]).toEqual([["manager", 90], ["legacy", 25]]);
});
