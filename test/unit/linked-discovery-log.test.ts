import { describe, expect, test } from "bun:test";
import { LINKED_DISCOVERY_TAG, createLinkedDiscoveryTracker, formatLinkedDiscoveryLines } from "../../src/jira-watch/linked-discovery-log.js";

describe("formatLinkedDiscoveryLines", () => {
  test("one line per kept item, kind+target, skipped=false", () => {
    const lines = formatLinkedDiscoveryLines("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }, { kind: "parent", target: "BUTCHR-421" }], []);
    expect(lines).toEqual([
      "[linked-discovery] BUTCHR-429 kind=issuelink target=BUTCHR-1 skipped=false",
      "[linked-discovery] BUTCHR-429 kind=parent target=BUTCHR-421 skipped=false",
    ]);
  });

  test("skipped extras get their own lines, skipped=true — maxLinkedItems caps discovery AND logs what was skipped", () => {
    const lines = formatLinkedDiscoveryLines("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }], [{ kind: "issuelink", target: "BUTCHR-2" }, { kind: "issuelink", target: "BUTCHR-3" }]);
    expect(lines).toEqual([
      "[linked-discovery] BUTCHR-429 kind=issuelink target=BUTCHR-1 skipped=false",
      "[linked-discovery] BUTCHR-429 kind=issuelink target=BUTCHR-2 skipped=true",
      "[linked-discovery] BUTCHR-429 kind=issuelink target=BUTCHR-3 skipped=true",
    ]);
  });

  test("nothing discovered -> no lines", () => {
    expect(formatLinkedDiscoveryLines("BUTCHR-429", [], [])).toEqual([]);
  });

  test("every line carries the tag", () => {
    for (const line of formatLinkedDiscoveryLines("K", [{ kind: "webpage", target: "https://example.com" }], [])) expect(line.startsWith(LINKED_DISCOVERY_TAG)).toBe(true);
  });
});

describe("createLinkedDiscoveryTracker: change-gated logging", () => {
  test("the first sighting of a resource is always a change", () => {
    const tracker = createLinkedDiscoveryTracker();
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }], [])).toBe(true);
  });

  test("an unchanged (kept, skipped) pair for the same resource is not a change the second time", () => {
    const tracker = createLinkedDiscoveryTracker();
    const kept = [{ kind: "issuelink", target: "BUTCHR-1" }];
    expect(tracker.changed("BUTCHR-429", kept, [])).toBe(true);
    expect(tracker.changed("BUTCHR-429", kept, [])).toBe(false);
    // A fresh array with the same content is still "unchanged" — comparison is by content, not identity.
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }], [])).toBe(false);
  });

  test("a real change (a link added) is reported again", () => {
    const tracker = createLinkedDiscoveryTracker();
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }], [])).toBe(true);
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }, { kind: "issuelink", target: "BUTCHR-2" }], [])).toBe(true);
  });

  test("moving from kept to skipped (a fresh maxLinkedItems cap) is a change even if the total set is the same", () => {
    const tracker = createLinkedDiscoveryTracker();
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }, { kind: "issuelink", target: "BUTCHR-2" }], [])).toBe(true);
    expect(tracker.changed("BUTCHR-429", [{ kind: "issuelink", target: "BUTCHR-1" }], [{ kind: "issuelink", target: "BUTCHR-2" }])).toBe(true);
  });

  test("two different resources are tracked independently", () => {
    const tracker = createLinkedDiscoveryTracker();
    expect(tracker.changed("BUTCHR-1", [{ kind: "issuelink", target: "X-1" }], [])).toBe(true);
    expect(tracker.changed("BUTCHR-2", [{ kind: "issuelink", target: "X-1" }], [])).toBe(true);
    expect(tracker.changed("BUTCHR-1", [{ kind: "issuelink", target: "X-1" }], [])).toBe(false);
  });
});
