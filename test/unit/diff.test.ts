import { describe, expect, test } from "bun:test";
import {
  activeKeys, changedKeys, daemonLabelsChanged, daemonLabelTransition, isDaemonLabelOnlyDiff, prTransition,
  isBookkeepingComment, excludeBookkeepingComments, WAKE_MARKERS, blockedTransition,
} from "../../src/jira-watch/diff.js";
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

  // BUTCHR-431: `description` joined `SEARCH_FIELDS` and now rides along on
  // every `JiraIssue`, but `changedKeys` reads only status/summary/updated —
  // a description-only edit (status/summary/updated all held constant) must
  // NOT newly count as a change, or every description edit would wake agents
  // that previously ignored it.
  test("a description-only difference is NOT a change — changedKeys never reads description", () => {
    const before = { ...iss("A", "In Progress", "s", "t1"), description: "old text" };
    const after = { ...iss("A", "In Progress", "s", "t1"), description: "new text, with a link https://example.com" };
    expect(changedKeys([before], [after])).toEqual([]);
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

describe("daemonLabelTransition (BUTCHR-87)", () => {
  test("agent:* value changing is named, with the namespace and both values", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle"]);
    expect(daemonLabelTransition(before, after)).toEqual({ prefix: "agent", from: "working", to: "idle" });
  });

  test("pr:* value changing is named too, not just agent:*", () => {
    const before = iss("A", "In Progress", "s", "t1", ["pr:open"]);
    const after = iss("A", "In Progress", "s", "t2", ["pr:approved"]);
    expect(daemonLabelTransition(before, after)).toEqual({ prefix: "pr", from: "open", to: "approved" });
  });

  test("a pr:* label appearing from nothing names from: null", () => {
    const before = iss("A", "In Progress", "s", "t1", []);
    const after = iss("A", "In Progress", "s", "t2", ["pr:open"]);
    expect(daemonLabelTransition(before, after)).toEqual({ prefix: "pr", from: null, to: "open" });
  });

  test("a pr:* label REMOVED entirely (to: null) is named — unlike prTransition, this function is naming what changed, not vetting a review-outstanding transition", () => {
    const before = iss("A", "In Progress", "s", "t1", ["pr:approved"]);
    const after = iss("A", "In Progress", "s", "t2", []);
    expect(daemonLabelTransition(before, after)).toEqual({ prefix: "pr", from: "approved", to: null });
  });

  test("both namespaces changed in the same diff -> pr:* wins, agent:* is not reported (deterministic precedence)", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working", "pr:open"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:idle", "pr:approved"]);
    expect(daemonLabelTransition(before, after)).toEqual({ prefix: "pr", from: "open", to: "approved" });
  });

  test("no daemon label of either kind on either side, and neither namespace's value differs -> null", () => {
    const before = iss("A", "In Progress", "s", "t1", ["urgent"]);
    const after = iss("A", "In Progress", "s", "t2", ["urgent", "another-human-label"]);
    expect(daemonLabelTransition(before, after)).toBeNull();
  });

  test("neither namespace's value differs even though the label ARRAY differs (agent:working present both sides, pr:open present both sides) -> null", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working", "pr:open"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working", "pr:open"]);
    expect(daemonLabelTransition(before, after)).toBeNull();
  });
});

describe("blockedTransition (FACTORY-949)", () => {
  for (const from of ["agent:none", "agent:working", "agent:idle", "agent:stalled"]) {
    test(`${from} -> agent:blocked is a transition`, () => {
      const before = iss("A", "In Progress", "s", "t1", from === "agent:none" ? [] : [from]);
      const after = iss("A", "In Progress", "s", "t2", ["agent:blocked"]);
      expect(blockedTransition(before, after)).toBe(true);
    });
  }

  test("agent:blocked -> anything is NOT a transition (the from side, not the to side)", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:blocked"]);
    for (const to of ["agent:none", "agent:working", "agent:idle", "agent:stalled"]) {
      const after = iss("A", "In Progress", "s", "t2", to === "agent:none" ? [] : [to]);
      expect(blockedTransition(before, after)).toBe(false);
    }
  });

  test("already agent:blocked on both sides is NOT a transition — no edge, just still blocked", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:blocked"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:blocked"]);
    expect(blockedTransition(before, after)).toBe(false);
  });

  test("working <-> idle, idle <-> stalled: never a transition", () => {
    expect(blockedTransition(iss("A", "In Progress", "s", "t1", ["agent:working"]), iss("A", "In Progress", "s", "t2", ["agent:idle"]))).toBe(false);
    expect(blockedTransition(iss("A", "In Progress", "s", "t1", ["agent:idle"]), iss("A", "In Progress", "s", "t2", ["agent:stalled"]))).toBe(false);
  });

  test("a pr:* flip alongside an unchanged agent:* label is not a blocked transition", () => {
    const before = iss("A", "In Progress", "s", "t1", ["agent:working", "pr:open"]);
    const after = iss("A", "In Progress", "s", "t2", ["agent:working", "pr:approved"]);
    expect(blockedTransition(before, after)).toBe(false);
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

// FACTORY-865: the whole point of this predicate is that butchr's own
// bookkeeping chatter must stop defeating daemon-label-only suppression
// while four specific agent-directed markers keep moving the cursor.
describe("isBookkeepingComment / WAKE_MARKERS (FACTORY-865)", () => {
  test("a non-daemon comment (no [butchr: prefix at all) is never bookkeeping", () => {
    expect(isBookkeepingComment("just a normal human/agent comment")).toBe(false);
    expect(isBookkeepingComment("[KAN-1] a report_to_boss-style identity-tagged comment")).toBe(false);
  });

  test("every current PROBABLY-BOOKKEEPING marker is bookkeeping", () => {
    for (const body of [
      "[butchr:reconcile] X's reconcile has failed",
      "[butchr:crashloop] X has been spawned 5 times",
      "[butchr:parked] X has been assigned and linked",
      "[butchr:abandoned] X is still open",
      "[butchr:pinned] X has read ACTIVE",
      "[butchr:frozen] X has read asleep",
      "[butchr:yieldloop] X has woken from stand_down",
      "[butchr:resume] X's agent was relaunched",
      "[butchr:restored-degraded] X has been unable to take butchr's full flag set",
    ]) {
      expect(isBookkeepingComment(body)).toBe(true);
    }
  });

  test("every allowlisted WAKE marker is NOT bookkeeping, even though it starts with the daemon-chatter prefix", () => {
    for (const marker of WAKE_MARKERS) expect(isBookkeepingComment(`${marker} some agent-directed text`)).toBe(false);
  });

  test("WAKE_MARKERS is exactly the four agent-directed markers this ticket names", () => {
    expect([...WAKE_MARKERS].sort()).toEqual(["[butchr:blocked]", "[butchr:respawn]", "[butchr:stall]", "[butchr:unresponsive]"]);
  });

  test("matching is prefix-based on the REAL marker text, not substring — a marker name appearing mid-sentence in an otherwise-bookkeeping comment does not exempt it", () => {
    expect(isBookkeepingComment("[butchr:parked] mentions [butchr:blocked] only in passing")).toBe(true);
  });
});

describe("excludeBookkeepingComments (FACTORY-865)", () => {
  test("drops bookkeeping comments, keeps real and allowlisted ones, preserves order", () => {
    const rows = [
      { id: "3", body: "[butchr:parked] noise" },
      { id: "2", body: "[butchr:blocked] waiting on a decision" },
      { id: "1", body: "a real human comment" },
    ];
    expect(excludeBookkeepingComments(rows).map((r) => r.id)).toEqual(["2", "1"]);
  });

  test("an all-bookkeeping list filters down to empty", () => {
    expect(excludeBookkeepingComments([{ id: "1", body: "[butchr:crashloop] x" }])).toEqual([]);
  });
});
