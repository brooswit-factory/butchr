import { describe, expect, test } from "bun:test";
import { formatConfluencePageRef, isConfluencePageRef, parseConfluencePageRef } from "../../src/resources/confluence-page-ref.js";

describe("parseConfluencePageRef", () => {
  test("a bare numeric page id", () => {
    expect(parseConfluencePageRef("123456")).toEqual({ pageId: "123456" });
  });

  test("extracts the page id from a full Confluence page URL — reuses pageIdFromUrl rather than a second regex", () => {
    expect(parseConfluencePageRef("https://wroosbit.atlassian.net/wiki/spaces/FACTORY/pages/39518269/Some+Title")).toEqual({ pageId: "39518269" });
  });

  test("a Confluence URL with no page id (e.g. a space overview) is not a confluence-page ref", () => {
    expect(parseConfluencePageRef("https://wroosbit.atlassian.net/wiki/spaces/FACTORY/overview")).toBeNull();
  });

  test("malformed input is null, never thrown", () => {
    for (const bad of ["", "not-a-number", "123abc", "https://example.com/no/page/id/here"]) expect(parseConfluencePageRef(bad)).toBeNull();
  });
});

describe("formatConfluencePageRef / isConfluencePageRef", () => {
  test("formats a valid ref", () => {
    expect(formatConfluencePageRef({ pageId: "123456" })).toBe("123456");
  });

  test("throws on a non-numeric id", () => {
    expect(() => formatConfluencePageRef({ pageId: "not-a-number" })).toThrow();
  });

  test("isConfluencePageRef true only for a bare numeric id", () => {
    expect(isConfluencePageRef("123456")).toBe(true);
    expect(isConfluencePageRef("https://example.com/wiki/pages/123456")).toBe(false);
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("a bare id and the URL naming the same page are equivalent", () => {
    const byId = parseConfluencePageRef("39518269")!;
    const byUrl = parseConfluencePageRef("https://wroosbit.atlassian.net/wiki/spaces/FACTORY/pages/39518269/Title")!;
    expect(formatConfluencePageRef(byId)).toBe(formatConfluencePageRef(byUrl));
  });

  test("different page ids are not equivalent", () => {
    expect(formatConfluencePageRef({ pageId: "1" })).not.toBe(formatConfluencePageRef({ pageId: "2" }));
  });
});
