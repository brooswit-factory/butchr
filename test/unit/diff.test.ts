import { describe, expect, test } from "bun:test";
import { activeKeys, changedKeys, isDaemonLabelOnlyDiff } from "../../src/jira-watch/diff.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const iss = (key: string, status = "In Progress", summary = "s", updated = "t", labels: string[] = []): JiraIssue =>
  ({ key, status, summary, issuetype: "Task", assignee: "a", parent: null, updated, labels });

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

describe("isDaemonLabelOnlyDiff", () => {
  test("only a daemon label (agent:*) changed, status/summary unchanged -> true", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(true);
  });
  test("only a pr:* label changed -> true", () => {
    const before = iss("A", "In Progress", "s", "t1", []);
    const after = iss("A", "In Progress", "s", "t2", ["pr:open"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(true);
  });
  test("no label change at all -> false (belongs to the exact-updated-match ledger, not this rule)", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(false);
  });
  test("status changed alongside a label change -> false", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Review", "s", "t2", ["agent:idle"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(false);
  });
  test("summary changed alongside a label change -> false", () => {
    const before = iss("A", "In Progress", "old", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "new", "t2", ["agent:idle"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(false);
  });
  test("a non-daemon (human) label changed alongside a daemon label -> false", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle", "urgent"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(false);
  });
  test("only a human label changed -> false", () => {
    const before = iss("A", "In Progress", "s", "t1", []);
    const after = iss("A", "In Progress", "s", "t2", ["urgent"]);
    expect(isDaemonLabelOnlyDiff(before, after)).toBe(false);
  });
});
