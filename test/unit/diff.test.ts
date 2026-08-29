import { describe, expect, test } from "bun:test";
import { activeKeys, changedKeys, daemonLabelsChanged, isDaemonLabelOnlyDiff, prTransition } from "../../src/jira-watch/diff.js";
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

describe("daemonLabelsChanged", () => {
  test("an agent:* flip (working -> idle) counts, even with nothing else changed", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle"]);
    expect(daemonLabelsChanged(before, after)).toBe(true);
  });
  test("a daemon label flip nested inside a status change still counts — unlike isDaemonLabelOnlyDiff, this never gates on status/summary equality", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Review", "s", "t2", ["agent:idle"]);
    expect(daemonLabelsChanged(before, after)).toBe(true);
  });
  test("no label change at all -> false — e.g. a pure comment bump (updated moved, labels didn't)", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working"]);
    expect(daemonLabelsChanged(before, after)).toBe(false);
  });
  test("only a non-daemon (human) label changed -> false", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working", "urgent"]);
    expect(daemonLabelsChanged(before, after)).toBe(false);
  });
  test("a daemon label added alongside a human label -> true (need not be the ONLY changed label, unlike isDaemonLabelOnlyDiff)", () => {
    const before = iss("A", "In Progress", "s", "t1", []);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working", "urgent"]);
    expect(daemonLabelsChanged(before, after)).toBe(true);
  });
  test("a pr:* label added counts too, not just agent:*", () => {
    const before = iss("A", "In Progress", "s", "t1", []);
    const after = iss("A", "In Progress", "s", "t2", ["pr:open"]);
    expect(daemonLabelsChanged(before, after)).toBe(true);
  });
});

describe("prTransition", () => {
  const withPr = (label: string | null) => iss("A", "In Progress", "s", "t", label ? [`pr:${label}`] : []);

  test("none -> open counts", () => {
    expect(prTransition(withPr(null), withPr("open"))).toEqual({ from: null, to: "open" });
  });
  test("open -> approved counts", () => {
    expect(prTransition(withPr("open"), withPr("approved"))).toEqual({ from: "open", to: "approved" });
  });
  test("open -> changes-requested counts", () => {
    expect(prTransition(withPr("open"), withPr("changes-requested"))).toEqual({ from: "open", to: "changes-requested" });
  });
  test("changes-requested -> approved counts", () => {
    expect(prTransition(withPr("changes-requested"), withPr("approved"))).toEqual({ from: "changes-requested", to: "approved" });
  });
  test("approved -> merged counts", () => {
    expect(prTransition(withPr("approved"), withPr("merged"))).toEqual({ from: "approved", to: "merged" });
  });
  test("a pure removal (pr:x -> no pr:* label at all) never counts, even though the label set changed", () => {
    expect(prTransition(withPr("approved"), withPr(null))).toBeNull();
  });
  test("an agent:*-only diff (no pr:* label involved at all) is not a transition", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle"]);
    expect(prTransition(before, after)).toBeNull();
  });
  test("no label change at all -> null", () => {
    expect(prTransition(withPr("open"), withPr("open"))).toBeNull();
  });
  test("a transition nested inside a status change still counts — status/summary are irrelevant to this rule", () => {
    const before = iss("A", "In Progress", "s", "t1", ["pr:open"]);
    const after = iss("A", "In Review", "s", "t2", ["pr:approved"]);
    expect(prTransition(before, after)).toEqual({ from: "open", to: "approved" });
  });
});
