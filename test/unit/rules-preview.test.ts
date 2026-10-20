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

  test("confluence-page preview enumerates every direct-child page through the cursor and returns bounded IDs", async () => {
    const cursors: Array<string | undefined> = [];
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "pages", resourceProvider: "confluence-page", query: '{"ancestor":"60096513"}' })],
      search: async () => { throw new Error("Jira must not be used for Confluence preview"); },
      getChildPages: async (ancestor, cursor) => {
        expect(ancestor).toBe("60096513");
        cursors.push(cursor);
        return cursor === undefined
          ? { results: [{ id: "101" }, { id: "102" }], nextCursor: "next" }
          : { results: [{ id: "103" }] };
      },
      maxAgents: 2,
      cap: 2,
    });
    const r = await preview("pages");
    expect(r).toEqual({
      ok: true,
      keys: ["101", "102"],
      total: 3,
      cap: 2,
      warning: "this rule would staff 3 real resource(s), exceeding maxAgents=2 — only 2 would run across the whole fleet this poll",
    });
    expect(cursors).toEqual([undefined, "next"]);
  });

  test("a draft confluence-page rule is previewable before it is saved", async () => {
    const preview = createRulesPreviewer({
      rules: () => [],
      search: async () => [],
      getChildPages: async (ancestor) => {
        expect(ancestor).toBe("60096513");
        return { results: [] };
      },
      maxAgents: 5,
    });
    await expect(preview("draft-pages", '{"ancestor":"60096513"}', "confluence-page"))
      .resolves.toEqual({ ok: true, keys: [], total: 0, cap: 50, warning: null });
  });

  test("a confluence enumeration failure is fail-closed without exposing its upstream error", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "pages", resourceProvider: "confluence-page", query: '{"ancestor":"60096513"}' })],
      search: async () => [],
      getChildPages: async () => { throw new Error("Confluence 401 token secret"); },
      maxAgents: 5,
    });
    await expect(preview("pages")).resolves.toEqual({ ok: false, status: 502, error: "preview failed: could not enumerate Confluence children" });
  });

  test("a Confluence enumeration that never resolves times out with the same fixed response", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "pages", resourceProvider: "confluence-page", query: '{"ancestor":"60096513"}' })],
      search: async () => [],
      getChildPages: () => new Promise(() => {}),
      maxAgents: 5,
      timeoutMs: 20,
    });
    await expect(preview("pages")).resolves.toEqual({ ok: false, status: 504, error: "preview timed out" });
  });

  test("a Confluence timeout aborts pagination before a completed first page can start its next request", async () => {
    let calls = 0;
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "pages", resourceProvider: "confluence-page", query: '{"ancestor":"60096513"}' })],
      search: async () => [],
      getChildPages: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { results: [], nextCursor: "next" };
      },
      maxAgents: 5,
      timeoutMs: 10,
    });
    await expect(preview("pages")).resolves.toEqual({ ok: false, status: 504, error: "preview timed out" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
  });

  test("a confluence preview without the existing child enumerator remains unavailable, never zero", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule({ id: "pages", resourceProvider: "confluence-page", query: '{"ancestor":"60096513"}' })],
      search: async () => [],
      maxAgents: 5,
    });
    await expect(preview("pages")).resolves.toEqual({ ok: false, status: 503, error: "preview unavailable: Confluence child enumeration is not configured" });
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

  // FACTORY-730 (ticket item 3): the edit dialog's own "what would this
  // CHANGED query match" dry-run, before that query is ever saved — dry-runs
  // the rule with `queryOverride` substituted for its own stored `query`,
  // never the rule's saved query, and never persists anything.
  test("FACTORY-730: queryOverride dry-runs a DIFFERENT (not-yet-saved) query, never the rule's own stored query", async () => {
    let seenJql: string | undefined;
    const preview = createRulesPreviewer({
      rules: () => [rule({ query: "project = OLD" })],
      search: async (jql) => {
        seenJql = jql;
        return jql === "project = NEW" ? [issue("F-1"), issue("F-2")] : [issue("F-0")];
      },
      maxAgents: 5,
    });
    const r = await preview("triage", "project = NEW");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total).toBe(2);
    expect(seenJql).toBe("project = NEW");
  });

  test("FACTORY-730: a disabled rule's draft query still dry-runs as if enabled (same B5c discipline as the no-override case)", async () => {
    const preview = createRulesPreviewer({
      rules: () => [rule({ enabled: false, query: "project = OLD" })],
      search: async () => [issue("F-1")],
      maxAgents: 5,
    });
    const r = await preview("triage", "project = NEW");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total).toBe(1);
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
