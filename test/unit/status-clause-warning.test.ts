import { describe, expect, test } from "bun:test";
import { statuslessJiraWorkRuleIds, statuslessJiraWorkRuleWarnings } from "../../src/rules/status-clause-warning.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "query">): Rule => ({ enabled: true, resourceProvider: "jira-work", brief: "b", ...over });

describe("statuslessJiraWorkRuleIds", () => {
  test("warns on a jira-work rule with no status clause at all", () => {
    expect(statuslessJiraWorkRuleIds([rule({ id: "triage", query: "assignee = currentUser() AND issuetype = Task" })])).toEqual(["triage"]);
  });

  test("silent on status = ..., status IN (...), and statusCategory != Done alike — detection is conservative, not a correctness check", () => {
    for (const query of [
      'assignee = currentUser() AND status = "In Progress"',
      'assignee = currentUser() AND status IN ("In Progress", "In Review")',
      "assignee = currentUser() AND statusCategory != Done",
      "STATUS in (Open)",
    ]) expect(statuslessJiraWorkRuleIds([rule({ id: "r", query })])).toEqual([]);
  });

  test("ignores non-jira-work rules and disabled rules", () => {
    expect(statuslessJiraWorkRuleIds([
      rule({ id: "gh", query: "no status here", resourceProvider: "github-issue" }),
      rule({ id: "off", query: "no status here", enabled: false }),
    ])).toEqual([]);
  });

  test("reports every offending rule, in file order", () => {
    expect(statuslessJiraWorkRuleIds([
      rule({ id: "a", query: "issuetype = Task" }),
      rule({ id: "b", query: 'status = "In Progress"' }),
      rule({ id: "c", query: "issuetype = Bug" }),
    ])).toEqual(["a", "c"]);
  });

  test("does not match a status-shaped substring that isn't the status field (no false positive from a fused identifier)", () => {
    expect(statuslessJiraWorkRuleIds([rule({ id: "r", query: "customfield_status_flag = 1" })])).toEqual(["r"]);
  });
});

describe("statuslessJiraWorkRuleWarnings", () => {
  test("names the rule id and stays a warning, never an error shape", () => {
    const [line] = statuslessJiraWorkRuleWarnings([rule({ id: "triage", query: "issuetype = Task" })]);
    expect(line).toStartWith("WARNING:");
    expect(line).toContain("triage");
  });
});

describe("docs/rules.example.json stays silent", () => {
  test("the canonical example never trips this warning", () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "docs", "rules.example.json"), "utf8"));
    expect(statuslessJiraWorkRuleWarnings(parseRules(doc))).toEqual([]);
  });
});
