import { describe, expect, test } from "bun:test";
import { pinnedActiveMinutesFor, type ProjectMatch } from "../../src/rules/jira-project-type.js";
import type { Rule } from "../../src/rules/rules.js";
import type { JiraProject } from "../../src/resources/jira-project.js";

function rule(over: Partial<Rule> & Pick<Rule, "id">): Rule {
  return { enabled: true, resourceProvider: "jira-project", query: "{}", brief: "b", execution: "singleton", account: "none", role: "worker", ...over };
}

function project(key: string): JiraProject {
  return { id: key, key, name: key };
}

function match(agentKey: string, r: Rule, projectKey: string): ProjectMatch {
  return { agentKey, rule: r, project: project(projectKey) };
}

/**
 * FACTORY-941: `pinnedActiveMinutesFor` is the pure resolution step
 * `src/daemon/index.ts` calls each poll (from its own
 * `projectType.discovery.search` wrap) to feed
 * `PinnedActiveDetectorDeps.minutesFor` — see that module's own doc
 * comment for the full contract. Tested here directly, independent of
 * index.ts (which cannot itself be imported in a test).
 */
describe("pinnedActiveMinutesFor", () => {
  test("a rule with an explicit idlePokeMinutes produces an entry keyed by that match's agentKey", () => {
    const r = rule({ id: "r1", idlePokeMinutes: 5 });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.get("jira-project:r1:ACME")).toBe(5);
  });

  test("a rule that leaves idlePokeMinutes unset produces no entry — caller's own global fallback applies", () => {
    const r = rule({ id: "r1" });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.has("jira-project:r1:ACME")).toBe(false);
  });

  test("a DISABLED rule's idlePokeMinutes is ignored entirely, even though it still produced a match", () => {
    const r = rule({ id: "r1", enabled: false, idlePokeMinutes: 5 });
    const result = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(result.has("jira-project:r1:ACME")).toBe(false);
  });

  test("two different rules matching two different projects resolve independently, one per agentKey — no cross-contamination", () => {
    const fast = rule({ id: "fast", idlePokeMinutes: 5 });
    const slow = rule({ id: "slow", idlePokeMinutes: 90 });
    const result = pinnedActiveMinutesFor([
      match("jira-project:fast:ACME", fast, "ACME"),
      match("jira-project:slow:WIDGET", slow, "WIDGET"),
    ]);
    expect(result.get("jira-project:fast:ACME")).toBe(5);
    expect(result.get("jira-project:slow:WIDGET")).toBe(90);
  });

  test("two DIFFERENT rules matching the SAME project produce two independent agentKeys, each with its own resolved minutes — no 'smallest wins' merge, unlike the issue tier's idlePokeRuleConfigByIssue", () => {
    const fast = rule({ id: "fast", idlePokeMinutes: 5 });
    const slow = rule({ id: "slow", idlePokeMinutes: 90 });
    const result = pinnedActiveMinutesFor([
      match("jira-project:fast:ACME", fast, "ACME"),
      match("jira-project:slow:ACME", slow, "ACME"),
    ]);
    expect(result.get("jira-project:fast:ACME")).toBe(5);
    expect(result.get("jira-project:slow:ACME")).toBe(90);
  });

  test("an empty match list (no jira-project rules matched this poll) resolves to an empty map", () => {
    expect(pinnedActiveMinutesFor([]).size).toBe(0);
  });

  test("is rebuilt fresh each call — a stale id from a PRIOR call's matches must not survive into a later call that no longer matches it (would otherwise poke a now-gone project at the wrong threshold)", () => {
    const r = rule({ id: "r1", idlePokeMinutes: 5 });
    const first = pinnedActiveMinutesFor([match("jira-project:r1:ACME", r, "ACME")]);
    expect(first.get("jira-project:r1:ACME")).toBe(5);
    const second = pinnedActiveMinutesFor([]);
    expect(second.has("jira-project:r1:ACME")).toBe(false);
  });
});
