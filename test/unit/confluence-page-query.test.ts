import { describe, expect, test } from "bun:test";
import { confluencePageQueryProblems, parseConfluencePageQuery } from "../../src/resources/confluence-page-query.js";

describe("confluencePageQueryProblems — validated at rule-load time, never touching the network", () => {
  test("a valid query has no problems", () => {
    expect(confluencePageQueryProblems(JSON.stringify({ ancestor: "123456" }))).toEqual([]);
  });

  test("invalid JSON", () => {
    expect(confluencePageQueryProblems("{not json")).toEqual([expect.stringContaining("query is not valid JSON")]);
  });

  test("a JSON array, not an object", () => {
    expect(confluencePageQueryProblems("[1,2,3]")).toEqual(["query must be a JSON object"]);
  });

  test("an unknown field is named", () => {
    expect(confluencePageQueryProblems(JSON.stringify({ ancestor: "1", extra: true }))).toEqual([expect.stringContaining('unknown field "extra"')]);
  });

  test("ancestor missing", () => {
    expect(confluencePageQueryProblems(JSON.stringify({}))).toEqual([expect.stringContaining("query.ancestor must be a non-empty string")]);
  });

  test("ancestor empty string", () => {
    expect(confluencePageQueryProblems(JSON.stringify({ ancestor: "   " }))).toEqual([expect.stringContaining("query.ancestor must be a non-empty string")]);
  });

  test("ancestor not a bare numeric id — a URL is refused, same as a {space,pageId} pair would be", () => {
    expect(confluencePageQueryProblems(JSON.stringify({ ancestor: "https://example.atlassian.net/wiki/spaces/X/pages/123456/Title" }))).toEqual([
      expect.stringContaining("must be a bare numeric Confluence page id"),
    ]);
  });

  test("ancestor non-numeric garbage", () => {
    expect(confluencePageQueryProblems(JSON.stringify({ ancestor: "abc" }))).toEqual([expect.stringContaining("must be a bare numeric Confluence page id")]);
  });

  test("multiple problems are all reported, not just the first", () => {
    const problems = confluencePageQueryProblems(JSON.stringify({ ancestor: "abc", extra: 1 }));
    expect(problems.length).toBe(2);
  });
});

describe("parseConfluencePageQuery", () => {
  test("parses a valid query, trimming the ancestor", () => {
    expect(parseConfluencePageQuery(JSON.stringify({ ancestor: " 123456 " }))).toEqual({ ancestor: "123456" });
  });

  test("throws for anything confluencePageQueryProblems would flag", () => {
    expect(() => parseConfluencePageQuery("{not json")).toThrow(/confluence-page query rejected/);
    expect(() => parseConfluencePageQuery(JSON.stringify({ ancestor: "not-a-page-id" }))).toThrow(/confluence-page query rejected/);
  });
});
