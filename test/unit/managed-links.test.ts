import { describe, expect, test } from "bun:test";
import { mergeEffectiveLinks } from "../../src/resources/managed-links.js";
import { parseResourceRef } from "../../src/resources/resource-ref.js";

const ref = (s: string) => parseResourceRef(s);

describe("mergeEffectiveLinks", () => {
  test("empty native and managed produces an empty effective set", () => {
    expect(mergeEffectiveLinks([], [])).toEqual([]);
  });

  test("native-only links are tagged \"native\"", () => {
    const a = ref("jira-project:BUTCHR");
    expect(mergeEffectiveLinks([a], [])).toEqual([{ ref: a, origin: "native" }]);
  });

  test("managed-only links are tagged \"managed\"", () => {
    const a = ref("jira-project:BUTCHR");
    expect(mergeEffectiveLinks([], [a])).toEqual([{ ref: a, origin: "managed" }]);
  });

  test("a link present in both sources is tagged \"both\" exactly once, not listed twice", () => {
    const a = ref("jira-project:BUTCHR");
    const result = mergeEffectiveLinks([a], [ref("jira-project:butchr")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.origin).toBe("both");
  });

  test("ordering contract: native first (in its own order), then managed-only (in its own order)", () => {
    const n1 = ref("jira-project:A");
    const n2 = ref("jira-project:B");
    const m1 = ref("jira-project:C");
    const m2 = ref("jira-project:D");
    const result = mergeEffectiveLinks([n1, n2], [m1, m2]);
    expect(result.map((e) => e.ref)).toEqual([n1, n2, m1, m2]);
  });

  test("a managed entry that duplicates an EARLIER managed entry (not native) still just dedups by canonical key", () => {
    const a = ref("jira-work-item:butchr-1");
    const b = ref("jira-work-item:BUTCHR-1");
    const result = mergeEffectiveLinks([], [a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.origin).toBe("managed");
  });

  test("distinct resources never collapse", () => {
    const a = ref("jira-project:A");
    const b = ref("jira-project:B");
    expect(mergeEffectiveLinks([a], [b])).toHaveLength(2);
  });
});
