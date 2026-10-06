import { describe, expect, test } from "bun:test";
import { createRulesPreviewer } from "../../src/web/rules-preview.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { Rule } from "../../src/rules/rules.js";

const issue = (key: string): JiraIssue => ({
  key, summary: `summary for ${key}`, status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01", labels: [],
});

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "triage",
    enabled: true,
    resourceProvider: "jira-work",
    query: "project = FACTORY",
    brief: "brief",
    execution: "swarm",
    account: "none",
    role: "worker",
    ...overrides,
  } as Rule;
}

describe("createRulesPreviewer", () => {
  test("unknown rule id: 404", async () => {
    const preview = createRulesPreviewer({ rules: () => [], search: async () => [], maxAgents: 5 });
    const r = await preview("nope");
    expect(r).toEqual({ ok: false, status: 404, error: "rule not found" });
  });

  test("non-Jira-backed provider: 400, never calls search", async () => {
    let called = false;
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "fs", resourceProvider: "filesystem" })],
      search: async () => { called = true; return []; },
      maxAgents: 5,
    });
    const r = await preview("fs");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.error).toContain("filesystem"); }
    expect(called).toBe(false);
  });

  test("keys and total, capped, no summary/status text anywhere (SPEC CHANGE b)", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => issue(`F-${i}`));
    const preview = createRulesPreviewer({ rules: () => [rule()], search: async () => issues, maxAgents: 10, cap: 3 });
    const r = await preview("triage");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keys).toEqual(["F-0", "F-1", "F-2"]);
      expect(r.total).toBe(5);
      expect(r.cap).toBe(3);
      expect(r.warning).toBeNull();
    }
    expect(JSON.stringify(r)).not.toContain("summary for");
    expect(JSON.stringify(r)).not.toContain("To Do");
  });

  test("total beyond cap is still reported in full via `total`, even though `keys` is capped", async () => {
    const issues = Array.from({ length: 120 }, (_, i) => issue(`F-${i}`));
    const preview = createRulesPreviewer({ rules: () => [rule()], search: async () => issues, maxAgents: 200 });
    const r = await preview("triage");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.keys).toHaveLength(50); expect(r.total).toBe(120); }
  });

  test("total exceeding maxAgents: a plain warning", async () => {
    const issues = Array.from({ length: 8 }, (_, i) => issue(`F-${i}`));
    const preview = createRulesPreviewer({ rules: () => [rule()], search: async () => issues, maxAgents: 3 });
    const r = await preview("triage");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("maxAgents=3");
  });

  test("jira-idea provider is previewable too, via the idea search path", async () => {
    const issues = [{ ...issue("IDEA-1"), issuetype: "Idea", projectType: "product_discovery" }];
    const preview = createRulesPreviewer({ rules: () => [rule({ id: "idea-rule", resourceProvider: "jira-idea" })], search: async () => issues, maxAgents: 5 });
    const r = await preview("idea-rule");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.keys).toEqual(["IDEA-1"]);
  });

  test("rate limited: a second call within rateLimitMs for the SAME rule is refused (429), without calling search again", async () => {
    let calls = 0;
    let now = 0;
    const preview = createRulesPreviewer({
      rules: () => [rule()],
      search: async () => { calls++; return [issue("F-1")]; },
      maxAgents: 5,
      now: () => now,
      rateLimitMs: 2000,
    });
    const r1 = await preview("triage");
    expect(r1.ok).toBe(true);
    now += 500;
    const r2 = await preview("triage");
    expect(r2).toEqual({ ok: false, status: 429, error: "rate limited: at most one preview per rule every 2000ms" });
    expect(calls).toBe(1);
  });

  test("after rateLimitMs elapses, a new call succeeds and calls search again", async () => {
    let calls = 0;
    let now = 0;
    const preview = createRulesPreviewer({
      rules: () => [rule()],
      search: async () => { calls++; return [issue("F-1")]; },
      maxAgents: 5,
      now: () => now,
      rateLimitMs: 2000,
    });
    await preview("triage");
    now += 2000;
    const r = await preview("triage");
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("two different rules are rate-limited independently", async () => {
    let now = 0;
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "a" }), rule({ id: "b" })],
      search: async () => [],
      maxAgents: 5,
      now: () => now,
      rateLimitMs: 2000,
    });
    const r1 = await preview("a");
    const r2 = await preview("b");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  test("a Jira search failure never surfaces the real error — fixed message only (SPEC CHANGE b)", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule()],
      search: async () => { throw new Error("Jira 500: internal server error, request id abc123, auth header leaked"); },
      maxAgents: 5,
    });
    const r = await preview("triage");
    expect(r).toEqual({ ok: false, status: 502, error: "preview failed: could not query Jira" });
  });

  test("a search that never resolves times out with a fixed message, bounded by timeoutMs", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule()],
      search: () => new Promise(() => {}),
      maxAgents: 5,
      timeoutMs: 20,
    });
    const r = await preview("triage");
    expect(r).toEqual({ ok: false, status: 504, error: "preview timed out" });
  });

  // B5c (agentsafety second pass, 2026-10-06): `searchRules`/
  // `searchJiraIdeaRules` both filter to `rule.enabled` first, so a DISABLED
  // rule (the seeded `ui-first-rule` template's own starting state)
  // previously dry-ran to zero matches regardless of its real query,
  // vacuously passing FACTORY-662's scope ceiling for a rule that would in
  // fact match far more once actually enabled.
  test("B5c: a DISABLED rule's preview still reports its real match count, not zero", async () => {
    const issues = Array.from({ length: 40 }, (_, i) => issue(`F-${i}`));
    let searchedJql: string | undefined;
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "ui-first-rule", enabled: false })],
      search: async (jql) => { searchedJql = jql; return issues; },
      maxAgents: 5,
      cap: 50,
    });
    const r = await preview("ui-first-rule");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total).toBe(40);
    expect(searchedJql).toBe("project = FACTORY"); // the rule's own query, unchanged
  });

  test("B5c: the disabled rule's OWN object is never mutated by the dry run", async () => {
    const theRule = rule({ id: "ui-first-rule", enabled: false });
    const preview = createRulesPreviewer({ rules: () => [theRule], search: async () => [], maxAgents: 5 });
    await preview("ui-first-rule");
    expect(theRule.enabled).toBe(false);
  });
});
