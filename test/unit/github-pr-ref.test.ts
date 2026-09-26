import { describe, expect, test } from "bun:test";
import { formatGithubIssueRef, parseGithubIssueRef } from "../../src/resources/github-issue-ref.js";
import { formatGithubPrRef, githubPrRefFromUrl, isGithubPrRef, parseGithubPrRef } from "../../src/resources/github-pr-ref.js";

describe("github-pr-ref: shares github-issue-ref's identity shape by delegation, not duplication", () => {
  test("owner/repo#number is canonical lowercase and round-trips, identically to github-issue-ref", () => {
    expect(formatGithubPrRef({ owner: "Acme", repo: "Widgets.js", number: 12 })).toBe("acme/widgets.js#12");
    expect(parseGithubPrRef("acme/widgets.js#12")).toEqual({ owner: "acme", repo: "widgets.js", number: 12 });
    for (const bad of ["Acme/widgets#1", "acme/widgets#0", "acme/widgets#01", "acme/..#1", "-acme/w#1", "acme/w", "a/b/c#1", "acme/w#1#2", "PROJ-1"]) expect(isGithubPrRef(bad)).toBe(false);
    expect(() => formatGithubPrRef({ owner: "a b", repo: "w", number: 1 })).toThrow();
  });

  test("a PR ref and an issue ref with the same owner/repo#number are byte-for-byte the same bare string — the two are told apart by provider prefix, never by payload shape", () => {
    const bare = "acme/widgets#12";
    expect(formatGithubPrRef({ owner: "acme", repo: "widgets", number: 12 })).toBe(bare);
    expect(formatGithubIssueRef({ owner: "acme", repo: "widgets", number: 12 })).toBe(bare);
    expect(parseGithubPrRef(bare)).toEqual(parseGithubIssueRef(bare));
  });

  test("githubPrRefFromUrl is re-exported verbatim from github-issue-ref.ts (the mutually-exclusive twin already tested there)", () => {
    expect(githubPrRefFromUrl("https://github.com/brooswit-factory/butchr/pull/395")).toEqual({ owner: "brooswit-factory", repo: "butchr", number: 395 });
    expect(githubPrRefFromUrl("https://github.com/o/r/issues/1")).toBeNull();
  });
});
