/**
 * BUTCHR-400: a loud startup WARNING — never a refusal, never a hard-coded
 * status gate — for an ENABLED `jira-work` rule whose JQL has no `status`
 * clause at all. The consolidation spec requires queries to stay fully
 * configurable with no fixed Jira status rules, so this only ever logs; it
 * never rewrites a query, drops a rule, or blocks startup.
 *
 * Detection is deliberately conservative: a query counts as having a status
 * clause the moment it contains the word `status` anywhere, case-insensitive
 * — `status = "In Progress"`, `status IN (...)`, and `statusCategory != Done`
 * all count, even though the last of those is exactly the shape this ticket
 * exists to steer deploys away from (it admits `To Do`). This function only
 * answers "did the author think about status at all", not "is the clause
 * correct" — a narrower, cheaper claim that stays honest about what it does
 * and doesn't catch.
 */
import type { Rule } from "./rules.js";

const HAS_STATUS_CLAUSE = /\bstatus/i;

/** Enabled `jira-work` rule ids whose JQL has no `status` clause at all, in file order. */
export function statuslessJiraWorkRuleIds(rules: readonly Rule[]): string[] {
  return rules
    .filter((r) => r.enabled && r.resourceProvider === "jira-work" && !HAS_STATUS_CLAUSE.test(r.query))
    .map((r) => r.id);
}

/** One human-readable warning line per statusless rule, or `[]` when none. */
export function statuslessJiraWorkRuleWarnings(rules: readonly Rule[]): string[] {
  return statuslessJiraWorkRuleIds(rules).map(
    (id) => `WARNING: jira-work rule "${id}" has no status clause in its JQL — it will match tickets in every status, including To Do. Add e.g. status IN ("In Progress", "In Review") unless that is genuinely intended.`,
  );
}
