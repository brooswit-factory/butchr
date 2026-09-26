import { describe, expect, test } from "bun:test";
import { formatJiraProjectRef, isJiraProjectRef, parseJiraProjectRef } from "../../src/resources/jira-project-ref.js";

describe("parseJiraProjectRef", () => {
  test("a canonical uppercase key", () => {
    expect(parseJiraProjectRef("BUTCHR")).toEqual({ key: "BUTCHR" });
  });

  test("case-folds to uppercase", () => {
    expect(parseJiraProjectRef("butchr")).toEqual({ key: "BUTCHR" });
  });

  test("an issue key (with a -<digits> suffix) is not a project id — mutually exclusive by construction", () => {
    expect(parseJiraProjectRef("BUTCHR-1")).toBeNull();
  });

  test("malformed input is null, never thrown", () => {
    for (const bad of ["", "not a key", "1BUTCHR", "-BUTCHR"]) expect(parseJiraProjectRef(bad)).toBeNull();
  });
});

describe("formatJiraProjectRef / isJiraProjectRef", () => {
  test("formats to the canonical uppercase form", () => {
    expect(formatJiraProjectRef({ key: "butchr" })).toBe("BUTCHR");
  });

  test("throws on an invalid ref", () => {
    expect(() => formatJiraProjectRef({ key: "BUTCHR-1" })).toThrow();
  });

  test("isJiraProjectRef is true only for the canonical form", () => {
    expect(isJiraProjectRef("BUTCHR")).toBe(true);
    expect(isJiraProjectRef("butchr")).toBe(false);
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("two spellings of one project key are equivalent", () => {
    expect(formatJiraProjectRef(parseJiraProjectRef("butchr")!)).toBe(formatJiraProjectRef(parseJiraProjectRef("BUTCHR")!));
  });

  test("different project keys are not equivalent", () => {
    expect(formatJiraProjectRef(parseJiraProjectRef("BUTCHR")!)).not.toBe(formatJiraProjectRef(parseJiraProjectRef("FACTORY")!));
  });
});
