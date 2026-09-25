import { describe, expect, test } from "bun:test";
import { formatJiraWorkItemRef, isJiraWorkItemRef, parseJiraWorkItemRef } from "../../src/resources/jira-work-item-ref.js";

describe("parseJiraWorkItemRef", () => {
  test("a canonical uppercase key", () => {
    expect(parseJiraWorkItemRef("BUTCHR-123")).toEqual({ key: "BUTCHR-123" });
  });

  test("case-folds a lowercase or mixed-case key to uppercase — dedup relies on this", () => {
    expect(parseJiraWorkItemRef("butchr-123")).toEqual({ key: "BUTCHR-123" });
    expect(parseJiraWorkItemRef("BuTchr-123")).toEqual({ key: "BUTCHR-123" });
  });

  test("a project key with no issue number is not a work item", () => {
    expect(parseJiraWorkItemRef("BUTCHR")).toBeNull();
  });

  test("malformed input is null, never thrown", () => {
    for (const bad of ["", "not a key", "123-BUTCHR", "BUTCHR--123", "-123"]) expect(parseJiraWorkItemRef(bad)).toBeNull();
  });
});

describe("formatJiraWorkItemRef / isJiraWorkItemRef", () => {
  test("formats to the canonical uppercase form", () => {
    expect(formatJiraWorkItemRef({ key: "butchr-1" })).toBe("BUTCHR-1");
  });

  test("throws on an invalid ref", () => {
    expect(() => formatJiraWorkItemRef({ key: "not a key" })).toThrow();
  });

  test("isJiraWorkItemRef is true only for the canonical (uppercase) form", () => {
    expect(isJiraWorkItemRef("BUTCHR-1")).toBe(true);
    expect(isJiraWorkItemRef("butchr-1")).toBe(false);
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("two spellings of one key format to the same canonical string — the mutation this guards: dropping the upper-case fold would make these two links instead of one", () => {
    const a = parseJiraWorkItemRef("butchr-42")!;
    const b = parseJiraWorkItemRef("BUTCHR-42")!;
    expect(formatJiraWorkItemRef(a)).toBe(formatJiraWorkItemRef(b));
  });

  test("different keys are not equivalent", () => {
    const a = parseJiraWorkItemRef("BUTCHR-1")!;
    const b = parseJiraWorkItemRef("BUTCHR-2")!;
    expect(formatJiraWorkItemRef(a)).not.toBe(formatJiraWorkItemRef(b));
  });
});
