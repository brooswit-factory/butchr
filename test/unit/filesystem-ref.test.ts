import { describe, expect, test } from "bun:test";
import { formatFilesystemRef, isFilesystemRef, parseFilesystemRef } from "../../src/resources/filesystem-ref.js";

describe("parseFilesystemRef", () => {
  test("an already-normalized absolute path", () => {
    expect(parseFilesystemRef("/srv/factory/butchr")).toEqual({ path: "/srv/factory/butchr" });
  });

  test("the root path", () => {
    expect(parseFilesystemRef("/")).toEqual({ path: "/" });
  });

  test("normalizes . and .. segments and duplicate slashes", () => {
    expect(parseFilesystemRef("/a/./b/../c")).toEqual({ path: "/a/c" });
    expect(parseFilesystemRef("//a//b/")).toEqual({ path: "/a/b" });
  });

  test("strips a trailing slash, except for the root", () => {
    expect(parseFilesystemRef("/a/b/")).toEqual({ path: "/a/b" });
  });

  test("a relative path is null, never thrown", () => {
    for (const bad of ["", "a/b", "./a", "../a", "relative"]) expect(parseFilesystemRef(bad)).toBeNull();
  });
});

describe("formatFilesystemRef / isFilesystemRef", () => {
  test("formats an already-canonical path unchanged", () => {
    expect(formatFilesystemRef({ path: "/a/b" })).toBe("/a/b");
  });

  test("throws on a relative path", () => {
    expect(() => formatFilesystemRef({ path: "a/b" })).toThrow();
  });

  test("isFilesystemRef is false for a non-canonical (unnormalized) path even though it names the same file", () => {
    expect(isFilesystemRef("/a/b")).toBe(true);
    expect(isFilesystemRef("/a/./b")).toBe(false);
    expect(isFilesystemRef("/a/b/")).toBe(false);
  });
});

describe("canonicalization / dedup equivalence", () => {
  test("two spellings of one path normalize to the same canonical form", () => {
    const a = parseFilesystemRef("/srv/./factory/../factory/butchr/")!;
    const b = parseFilesystemRef("/srv/factory/butchr")!;
    expect(formatFilesystemRef(a)).toBe(formatFilesystemRef(b));
  });

  test("case is NOT folded — /srv/Foo and /srv/foo are different files, by design", () => {
    const a = parseFilesystemRef("/srv/Foo")!;
    const b = parseFilesystemRef("/srv/foo")!;
    expect(formatFilesystemRef(a)).not.toBe(formatFilesystemRef(b));
  });
});
