import { describe, expect, test } from "bun:test";
import { activeKeys, changedKeys } from "../../src/jira-watch/diff.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const iss = (key: string, status = "In Progress", summary = "s", updated = "t"): JiraIssue =>
  ({ key, status, summary, issuetype: "Task", assignee: "a", parent: null, updated, labels: [] });

describe("activeKeys", () => {
  test("keeps only active-status issues", () => {
    expect(activeKeys([iss("A", "In Progress"), iss("B", "To Do"), iss("C", "In Review")])).toEqual(["A", "C"]);
  });
});
describe("changedKeys", () => {
  test("new, gone, and field-changed keys count; unchanged do not", () => {
    const prev = [iss("A"), iss("B"), iss("C", "In Progress", "s", "t1")];
    const next = [iss("A"), iss("C", "In Review", "s", "t1"), iss("D")]; // B gone, C status changed, D new, A same
    expect(changedKeys(prev, next)).toEqual(["B", "C", "D"]);
  });
  test("a summary or updated change is a change", () => {
    expect(changedKeys([iss("A", "In Progress", "old")], [iss("A", "In Progress", "new")])).toEqual(["A"]);
    expect(changedKeys([iss("A", "In Progress", "s", "t1")], [iss("A", "In Progress", "s", "t2")])).toEqual(["A"]);
  });
});
