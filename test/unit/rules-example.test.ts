import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRules } from "../../src/rules/rules.js";

/**
 * BUTCHR-400: `docs/rules.example.json` is the canonical default every
 * deploy provisions its rules file from. This test loads it through the
 * REAL loader/validator (`loadRules`, the same function `src/daemon/index.ts`
 * calls at startup) rather than a hand-copied fixture, so a schema change in
 * `src/rules/rules.ts` that the example no longer satisfies fails here
 * instead of drifting silently. It then asserts the one property this
 * ticket exists to guarantee: every ticket-worker (`jira-work`) rule's JQL
 * admits only `In Progress` / `In Review` and never the `statusCategory !=
 * Done` shape that also admits `To Do`.
 */
const EXAMPLE_PATH = join(import.meta.dir, "..", "..", "docs", "rules.example.json");
const IN_PROGRESS_IN_REVIEW = 'status IN ("In Progress", "In Review")';

describe("docs/rules.example.json", () => {
  test("loads cleanly through the real rules loader", () => {
    const loaded = loadRules({ BUTCHR_RULES_FILE: EXAMPLE_PATH });
    expect(loaded.origin).toBe("file");
    expect(loaded.path).toBe(EXAMPLE_PATH);
    expect(loaded.rules.length).toBeGreaterThan(0);
  });

  test("covers exactly one ticket-worker rule per role: epics, stories, tasks, bugs, subtasks", () => {
    const { rules } = loadRules({ BUTCHR_RULES_FILE: EXAMPLE_PATH });
    expect(rules.every((r) => r.resourceProvider === "jira-work")).toBe(true);
    expect(rules.every((r) => r.enabled)).toBe(true);
    expect(new Set(rules.map((r) => r.id))).toEqual(new Set(["epics", "stories", "tasks", "bugs", "subtasks"]));
    expect(rules.map((r) => r.query)).toEqual([
      'assignee = currentUser() AND issuetype = Epic AND status IN ("In Progress", "In Review")',
      'assignee = currentUser() AND issuetype = Story AND status IN ("In Progress", "In Review")',
      'assignee = currentUser() AND issuetype = Task AND status IN ("In Progress", "In Review")',
      'assignee = currentUser() AND issuetype = Bug AND status IN ("In Progress", "In Review")',
      'assignee = currentUser() AND issuetype = "Sub-task" AND status IN ("In Progress", "In Review")',
    ]);
  });

  test("every jira-work ticket-worker rule's JQL includes the In Progress / In Review clause and never matches statusCategory", () => {
    const { rules } = loadRules({ BUTCHR_RULES_FILE: EXAMPLE_PATH });
    const ticketWorkerRules = rules.filter((r) => r.resourceProvider === "jira-work");
    expect(ticketWorkerRules.length).toBe(rules.length); // this file is ticket-worker rules only
    for (const rule of ticketWorkerRules) {
      expect(rule.query).toContain(IN_PROGRESS_IN_REVIEW);
      expect(rule.query).not.toMatch(/statusCategory/i);
      // The exact defect this file replaces: `statusCategory != Done` admits To Do.
      expect(rule.query).not.toMatch(/!=\s*Done/i);
    }
  });

  test("every rule's assignee clause matches by role, not a hard-coded account", () => {
    const { rules } = loadRules({ BUTCHR_RULES_FILE: EXAMPLE_PATH });
    for (const rule of rules) expect(rule.query).toContain("assignee = currentUser()");
  });
});
