import { describe, expect, test } from "bun:test";
import { bossKeyFrom, ISSUE_SPAWN_CONFIG } from "../../src/resources/issue.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "KAN-757",
  summary: "s",
  status: "In Progress",
  issuetype: "Task",
  assignee: null,
  parent: null,
  updated: "2026-08-24",
  labels: [],
  ...over,
});

// BUTCHR-169: SpawnSpec.parent (fed into {{PARENT}}) used to read
// issue.parent (Jira's native field) directly, which this fleet never
// populates for a boss/worker pair — verified live against three tickets
// while building this fix. bossKeyFrom is the actual source fix: derive the
// boss from an inward Implements link, the SAME convention findBossKey
// (src/tools/docs.ts) uses on the raw-JSON shape jira_get_issue returns.
describe("bossKeyFrom", () => {
  test("finds the boss via an inward Implements link — the SAME direction findBossKey uses", () => {
    expect(bossKeyFrom(issue({ issuelinks: [{ type: "Implements", otherEnd: "inward", key: "KAN-759" }] }))).toBe("KAN-759");
  });
  test("an OUTWARD Implements link means this issue IS the boss, not that it HAS one — must not be read as the boss key", () => {
    expect(bossKeyFrom(issue({ issuelinks: [{ type: "Implements", otherEnd: "outward", key: "KAN-757-child" }] }))).toBeNull();
  });
  test("a non-Implements link (Blocks, Relates) is never mistaken for boss-hood", () => {
    expect(bossKeyFrom(issue({ issuelinks: [{ type: "Relates", otherEnd: "inward", key: "KAN-1" }] }))).toBeNull();
  });
  test("no issuelinks at all (field absent, e.g. a caller that didn't request it) -> no boss, not a throw", () => {
    expect(bossKeyFrom(issue())).toBeNull();
  });
  test("an empty issuelinks array (a genuinely top-level ticket) -> no boss", () => {
    expect(bossKeyFrom(issue({ issuelinks: [] }))).toBeNull();
  });
  test("Jira's native `parent` field is NEVER consulted, even when populated — this fleet's boss relationship is link-only", () => {
    expect(bossKeyFrom(issue({ parent: "KAN-EPIC", issuelinks: [] }))).toBeNull();
  });
});

describe("ISSUE_SPAWN_CONFIG.specFor", () => {
  test("parent comes from the Implements link, not issue.parent", () => {
    const spec = ISSUE_SPAWN_CONFIG.specFor(issue({ parent: "WRONG-FIELD", issuelinks: [{ type: "Implements", otherEnd: "inward", key: "KAN-759" }] }));
    expect(spec).toEqual({ key: "KAN-757", issuetype: "Task", summary: "s", parent: "KAN-759" });
  });
  test("a genuinely top-level ticket spawns with parent: null", () => {
    const spec = ISSUE_SPAWN_CONFIG.specFor(issue({ issuelinks: [] }));
    expect(spec.parent).toBeNull();
  });
});
