import { describe, expect, test } from "bun:test";
import { formatJiraComponentRef, isJiraComponentId, isJiraComponentRef, parseJiraComponentRef } from "../../src/resources/jira-component-ref.js";

describe("parseJiraComponentRef", () => {
  test("a canonical `<PROJECT>:<id>` form", () => {
    expect(parseJiraComponentRef("BUTCHR:10000")).toEqual({ project: "BUTCHR", id: "10000" });
  });

  test("case-folds the project segment to uppercase; the component id segment is untouched", () => {
    expect(parseJiraComponentRef("butchr:10000")).toEqual({ project: "BUTCHR", id: "10000" });
  });

  test("malformed input is null, never thrown", () => {
    for (const bad of ["", "BUTCHR", "BUTCHR:", ":10000", "1BUTCHR:10000", "BUTCHR:0", "BUTCHR:01", "BUTCHR:abc", "BUTCHR:10000:extra", "BUTCHR-1:10000"]) {
      expect(parseJiraComponentRef(bad)).toBeNull();
    }
  });
});

describe("formatJiraComponentRef / isJiraComponentRef", () => {
  test("formats to the canonical uppercase-project form", () => {
    expect(formatJiraComponentRef({ project: "butchr", id: "10000" })).toBe("BUTCHR:10000");
  });

  test("throws on an invalid ref", () => {
    expect(() => formatJiraComponentRef({ project: "BUTCHR", id: "0" })).toThrow();
    expect(() => formatJiraComponentRef({ project: "1BAD", id: "1" })).toThrow();
  });

  test("isJiraComponentRef is true only for the canonical form", () => {
    expect(isJiraComponentRef("BUTCHR:10000")).toBe(true);
    expect(isJiraComponentRef("butchr:10000")).toBe(false);
  });
});

describe("isJiraComponentId", () => {
  test("digits only, no leading zero, never empty", () => {
    expect(isJiraComponentId("10000")).toBe(true);
    expect(isJiraComponentId("1")).toBe(true);
    expect(isJiraComponentId("0")).toBe(false);
    expect(isJiraComponentId("01")).toBe(false);
    expect(isJiraComponentId("")).toBe(false);
    expect(isJiraComponentId("10a")).toBe(false);
  });
});

/**
 * FACTORY-990/FACTORY-986 scope item (b): the canonical id is stable under a
 * Jira component RENAME. A fake Jira "component" here is exactly the two
 * fields the real REST API returns (`id`, `name`) — the ref is built from
 * `id` alone, so renaming (changing `name`, never `id`) must not change the
 * formatted ref.
 */
describe("id stability under rename (fake Jira)", () => {
  function fakeJiraComponent(id: string, name: string) {
    return { id, name };
  }

  test("renaming a component (same id, different name) produces the identical canonical ref", () => {
    const before = fakeJiraComponent("10000", "Backend");
    const after = fakeJiraComponent("10000", "Backend (renamed)");
    const refBefore = formatJiraComponentRef({ project: "BUTCHR", id: before.id });
    const refAfter = formatJiraComponentRef({ project: "BUTCHR", id: after.id });
    expect(refAfter).toBe(refBefore);
    expect(refAfter).toBe("BUTCHR:10000");
  });

  test("two components with the same name but different ids are NOT the same resource — the name is never load-bearing for identity", () => {
    const a = fakeJiraComponent("10000", "Backend");
    const b = fakeJiraComponent("20000", "Backend");
    expect(formatJiraComponentRef({ project: "BUTCHR", id: a.id })).not.toBe(formatJiraComponentRef({ project: "BUTCHR", id: b.id }));
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("two spellings of one component ref are equivalent", () => {
    expect(formatJiraComponentRef(parseJiraComponentRef("butchr:10000")!)).toBe(formatJiraComponentRef(parseJiraComponentRef("BUTCHR:10000")!));
  });

  test("different component ids under the same project are not equivalent", () => {
    expect(formatJiraComponentRef(parseJiraComponentRef("BUTCHR:10000")!)).not.toBe(formatJiraComponentRef(parseJiraComponentRef("BUTCHR:20000")!));
  });

  test("the same component id under different projects is not equivalent — project is part of identity", () => {
    expect(formatJiraComponentRef(parseJiraComponentRef("BUTCHR:10000")!)).not.toBe(formatJiraComponentRef(parseJiraComponentRef("FACTORY:10000")!));
  });
});
