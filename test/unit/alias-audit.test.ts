import { describe, expect, test } from "bun:test";
import { aliasTag, classifyCreateIssue, classifyLinkIssues, parseAliasAuditLine } from "../../src/tools/alias-audit.js";

describe("aliasTag", () => {
  test("renders the machine-readable bracket exactly", () => {
    expect(aliasTag("jira_transition", "drift")).toBe("[alias tool=jira_transition class=drift]");
  });
});

describe("classifyLinkIssues", () => {
  test("an Implements-type call is AMBIGUOUS — could be drift or the deliberate boss-steal override", () => {
    expect(classifyLinkIssues("Implements")).toBe("ambiguous");
  });
  test("any non-Implements type is SANCTIONED — the tool's own description calls it the only route", () => {
    expect(classifyLinkIssues("Blocks")).toBe("sanctioned");
    expect(classifyLinkIssues("Relates")).toBe("sanctioned");
  });
});

describe("classifyCreateIssue", () => {
  test("an Epic is SANCTIONED regardless of implements — new_worker never creates one", () => {
    expect(classifyCreateIssue("Epic", undefined)).toBe("sanctioned");
    expect(classifyCreateIssue("Epic", "KAN-1")).toBe("sanctioned");
  });
  test('a deliberate orphan ("none", case/space-insensitive) is SANCTIONED for Story and Task', () => {
    expect(classifyCreateIssue("Story", "none")).toBe("sanctioned");
    expect(classifyCreateIssue("Task", "  NONE  ")).toBe("sanctioned");
  });
  test("a Story/Task with a real (or missing/attempted) implements target is DRIFT — the shape new_worker replaces", () => {
    expect(classifyCreateIssue("Story", "KAN-1")).toBe("drift");
    expect(classifyCreateIssue("Task", undefined)).toBe("drift");
  });
});

describe("parseAliasAuditLine", () => {
  test("a new-format line yields identity, tool, and classification", () => {
    const line = "Sep 01 16:05:03 servyboi bun[507430]:   [tools] BUTCHR-63 → transition KAN-1 → Done [deprecated alias; use finish_worker] [alias tool=jira_transition class=drift]";
    expect(parseAliasAuditLine(line)).toEqual({ identity: "BUTCHR-63", tool: "jira_transition", classification: "drift" });
  });

  test("a sanctioned new-format line parses to class=sanctioned", () => {
    const line = "  [tools] KAN-7 → link KAN-2 → KAN-9 (Blocks) — non-Implements link type; still the only route for it [alias tool=jira_link_issues class=sanctioned]";
    expect(parseAliasAuditLine(line)).toEqual({ identity: "KAN-7", tool: "jira_link_issues", classification: "sanctioned" });
  });

  test("an ambiguous new-format line parses to class=ambiguous", () => {
    const line = "  [tools] KAN-7 → assign KAN-1 → acct-1 [deprecated alias; use adopt_worker] [alias tool=jira_assign class=ambiguous]";
    expect(parseAliasAuditLine(line)).toEqual({ identity: "KAN-7", tool: "jira_assign", classification: "ambiguous" });
  });

  // REQUIRED (acceptance criterion): a pre-BUTCHR-63 line, with the old unconditional
  // marker and no machine tag, is a REAL alias call whose classification cannot be
  // recovered without guessing at prose — it must be counted and labelled "unknown",
  // never silently dropped as if it weren't an alias call at all.
  test("an old-format line (no machine tag) is counted, not dropped — classification is 'unknown', tool is null", () => {
    const line = "Aug 20 09:00:00 servyboi bun[1]:   [tools] KAN-7 → link KAN-2 → KAN-9 (Implements) [deprecated alias; use new_worker/adopt_worker for an Implements link]";
    expect(parseAliasAuditLine(line)).toEqual({ identity: "KAN-7", tool: null, classification: "unknown" });
  });

  test("a permanent-verb line (no deprecation marker at all) is not an alias call — returns null", () => {
    const line = "  [tools] KAN-7 → get KAN-1";
    expect(parseAliasAuditLine(line)).toBeNull();
  });

  test("a relationship-verb line is not an alias call — returns null", () => {
    const line = "  [tools] KAN-9 → start_worker KAN-9";
    expect(parseAliasAuditLine(line)).toBeNull();
  });

  test("a line with no [tools] audit marker at all is not parseable — returns null", () => {
    expect(parseAliasAuditLine("Sep 01 16:05:07 servyboi bun[507430]:   [pr] searches=3 remaining=28")).toBeNull();
  });
});
