import { describe, expect, test } from "bun:test";
import { isIssueKey, isProjectId } from "../../src/resources/id.js";
import { JIRA_KEY_RE } from "../../src/tools/docs.js";

// BUTCHR-71: the id predicate module. What would make each check below
// fail, stated up front (per the ticket's own "say what would make this
// fail before you run it" requirement):
//  - isIssueKey diverging from JIRA_KEY_RE (a retyped/second copy drifting
//    out of sync) would fail the "delegates, does not retype" test.
//  - isProjectId accepting a hyphenated string, or rejecting the underscore
//    case the real regex allows, would fail the shape tests below.
//  - Any string matching BOTH predicates would fail the mutual-exclusivity
//    test — the whole point of BUTCHR-62's binding decision is that a
//    project id and an issue key can never collide.

describe("isIssueKey", () => {
  test("delegates to the codebase's exported JIRA_KEY_RE, not a retyped copy", () => {
    // If this module retyped the pattern instead of importing it, this
    // would still likely pass for common cases but would silently drift the
    // moment JIRA_KEY_RE changes — asserting identity of behavior against a
    // battery of cases is the check that would actually catch a fork.
    for (const s of ["BUTCHR-1", "BUTCHR-27", "MY_PROJ-1", "A-0", "butchr-1", "BUTCHR", "BUTCHR-", "-1", ""]) {
      expect(isIssueKey(s)).toBe(JIRA_KEY_RE.test(s));
    }
  });

  test("accepts a standard issue key", () => {
    expect(isIssueKey("BUTCHR-71")).toBe(true);
  });

  test("accepts the underscore case (JIRA_KEY_RE's project-prefix allows it, unlike src/daemon/index.ts's private KEY_RE)", () => {
    expect(isIssueKey("MY_PROJECT-1")).toBe(true);
  });

  test("rejects a bare project key (no -<digits> suffix)", () => {
    expect(isIssueKey("BUTCHR")).toBe(false);
  });

  test("rejects lowercase", () => {
    expect(isIssueKey("butchr-1")).toBe(false);
  });
});

describe("isProjectId", () => {
  test("accepts a standard project key", () => {
    expect(isProjectId("BUTCHR")).toBe(true);
  });

  test("accepts the underscore case, same charset as an issue key's own project-prefix", () => {
    expect(isProjectId("MY_PROJECT")).toBe(true);
  });

  test("rejects anything with a hyphen — a project key never contains one", () => {
    expect(isProjectId("BUTCHR-71")).toBe(false);
    expect(isProjectId("BUTCHR-")).toBe(false);
  });

  test("rejects lowercase and empty", () => {
    expect(isProjectId("butchr")).toBe(false);
    expect(isProjectId("")).toBe(false);
  });
});

describe("isIssueKey / isProjectId are mutually exclusive by construction", () => {
  test("no string satisfies both, across a battery of shapes including the underscore case", () => {
    const cases = ["BUTCHR-71", "BUTCHR", "MY_PROJECT", "MY_PROJECT-1", "butchr", "butchr-1", "", "-", "A", "A-1", "A_B_C", "A_B_C-99"];
    for (const s of cases) {
      expect(isIssueKey(s) && isProjectId(s)).toBe(false);
    }
  });
});
