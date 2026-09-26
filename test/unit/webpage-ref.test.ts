import { describe, expect, test } from "bun:test";
import { formatWebpageRef, isWebpageRef, parseWebpageRef } from "../../src/resources/webpage-ref.js";

describe("parseWebpageRef", () => {
  test("an already-canonical URL round-trips unchanged", () => {
    expect(parseWebpageRef("https://example.com/resource")).toEqual({ url: "https://example.com/resource" });
  });

  test("lower-cases scheme and host", () => {
    expect(parseWebpageRef("HTTPS://Example.COM/resource")).toEqual({ url: "https://example.com/resource" });
  });

  test("strips the default port for the scheme", () => {
    expect(parseWebpageRef("https://example.com:443/x")).toEqual({ url: "https://example.com/x" });
    expect(parseWebpageRef("http://example.com:80/x")).toEqual({ url: "http://example.com/x" });
  });

  test("keeps a non-default port", () => {
    expect(parseWebpageRef("https://example.com:8443/x")).toEqual({ url: "https://example.com:8443/x" });
  });

  test("strips the fragment", () => {
    expect(parseWebpageRef("https://example.com/x#section")).toEqual({ url: "https://example.com/x" });
  });

  test("strips a trailing slash, except for the bare root", () => {
    expect(parseWebpageRef("https://example.com/x/")).toEqual({ url: "https://example.com/x" });
    expect(parseWebpageRef("https://example.com/")).toEqual({ url: "https://example.com/" });
    expect(parseWebpageRef("https://example.com")).toEqual({ url: "https://example.com/" });
  });

  test("keeps the query string byte-for-byte, tracking parameters included — deliberately not resolved", () => {
    expect(parseWebpageRef("https://example.com/x?utm_source=foo&b=1")).toEqual({ url: "https://example.com/x?utm_source=foo&b=1" });
  });

  test("preserves path case — unlike the host, a path is case-sensitive", () => {
    expect(parseWebpageRef("https://Example.com/Some/Path")).toEqual({ url: "https://example.com/Some/Path" });
  });

  test("rejects embedded credentials", () => {
    expect(parseWebpageRef("https://user:pass@example.com/x")).toBeNull();
  });

  test("rejects a non-http(s) scheme", () => {
    expect(parseWebpageRef("ftp://example.com/x")).toBeNull();
  });

  test("malformed input is null, never thrown", () => {
    expect(parseWebpageRef("not a url")).toBeNull();
  });
});

describe("formatWebpageRef / isWebpageRef", () => {
  test("formats a non-canonical URL to its canonical form", () => {
    expect(formatWebpageRef({ url: "HTTPS://Example.com:443/x/" })).toBe("https://example.com/x");
  });

  test("throws on an invalid ref", () => {
    expect(() => formatWebpageRef({ url: "not a url" })).toThrow();
  });

  test("isWebpageRef is true only for a fixed point of canonicalization", () => {
    expect(isWebpageRef("https://example.com/x")).toBe(true);
    expect(isWebpageRef("https://example.com/x/")).toBe(false);
    expect(isWebpageRef("HTTPS://example.com/x")).toBe(false);
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("two spellings of one URL are equivalent", () => {
    const a = parseWebpageRef("HTTPS://Example.com:443/x/")!;
    const b = parseWebpageRef("https://example.com/x")!;
    expect(formatWebpageRef(a)).toBe(formatWebpageRef(b));
  });

  test("different query strings are NOT equivalent — no tracking-parameter resolution in v1", () => {
    const a = parseWebpageRef("https://example.com/x?a=1")!;
    const b = parseWebpageRef("https://example.com/x?a=2")!;
    expect(formatWebpageRef(a)).not.toBe(formatWebpageRef(b));
  });
});
