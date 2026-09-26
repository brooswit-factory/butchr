import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRules, parseRules } from "../../src/rules/rules.js";

/**
 * FACTORY-57 requirement 6: "a rules file containing no `github-pr` rules
 * must load and behave exactly as before" — this loads a representative,
 * pre-existing-style rules file (one rule per one of the OTHER providers
 * already in this repo: `jira-work`, `github-issue`, `filesystem`) through
 * the REAL loader (`loadRules`, the same function `src/daemon/index.ts`
 * calls at startup) and pins the exact parsed result, so a `github-pr`
 * addition that accidentally touched shared validation/parsing code for
 * these OTHER providers fails here loudly rather than passing silently.
 */
const FIXTURE_PATH = join(import.meta.dir, "..", "fixtures", "rules-mixed-providers.json");

describe("a mixed, github-pr-free rules file loads and parses unchanged", () => {
  test("loads cleanly through the real rules loader, one rule per provider, none of them github-pr", () => {
    const loaded = loadRules({ BUTCHR_RULES_FILE: FIXTURE_PATH });
    expect(loaded.origin).toBe("file");
    expect(loaded.rules.map((r) => r.resourceProvider)).toEqual(["jira-work", "github-issue", "filesystem"]);
    expect(loaded.rules.some((r) => r.resourceProvider === "github-pr")).toBe(false);
  });

  test("every rule's parsed shape is exactly what it would have been before github-pr existed — full pin, not just the provider field", () => {
    const { rules } = loadRules({ BUTCHR_RULES_FILE: FIXTURE_PATH });
    expect(rules).toEqual([
      {
        id: "tasks", enabled: true, resourceProvider: "jira-work",
        query: 'assignee = currentUser() AND issuetype = Task AND status IN ("In Progress", "In Review")',
        brief: "@builtin:task", execution: "swarm", account: "none", role: "worker",
      },
      {
        id: "bugs", enabled: true, resourceProvider: "github-issue",
        query: "type:Bug is:open", brief: "Fix the bug, then comment what you did.",
        execution: "swarm", account: "none", role: "worker",
      },
      {
        id: "configs", enabled: true, resourceProvider: "filesystem",
        query: '{"root":"/srv/factory/config","kind":"file","namePattern":"*.json","maxDepth":2}',
        brief: "Keep this config file correct and well-formed.", execution: "swarm", account: "none", role: "worker",
      },
    ]);
  });

  test("re-parsing the SAME document text directly through parseRules (bypassing the file loader) gives the identical result", () => {
    const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(parseRules(doc, FIXTURE_PATH)).toEqual(loadRules({ BUTCHR_RULES_FILE: FIXTURE_PATH }).rules);
  });

  test("adding an unrelated, disabled github-pr rule alongside these three changes nothing about how the three OTHER rules parse", () => {
    const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { rules: object[] };
    const withPr = parseRules({ rules: [...doc.rules, { id: "prs", enabled: false, resourceProvider: "github-pr", query: "is:open", brief: "review it" }] });
    const withoutPr = parseRules(doc);
    expect(withPr.slice(0, 3)).toEqual(withoutPr);
    expect(withPr[3]).toMatchObject({ id: "prs", enabled: false, resourceProvider: "github-pr" });
  });
});
