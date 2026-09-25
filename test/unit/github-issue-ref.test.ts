import { describe, expect, test } from "bun:test";
import { githubPrRefFromUrl, githubIssueRefFromUrl } from "../../src/resources/github-issue-ref.js";

describe("githubPrRefFromUrl: BUTCHR-429's twin of githubIssueRefFromUrl", () => {
  test("a canonical PR URL", () => {
    expect(githubPrRefFromUrl("https://github.com/brooswit-factory/butchr/pull/395")).toEqual({ owner: "brooswit-factory", repo: "butchr", number: 395 });
  });

  test("owner/repo are lowercased", () => {
    expect(githubPrRefFromUrl("https://github.com/Brooswit-Factory/Butchr/pull/395")).toEqual({ owner: "brooswit-factory", repo: "butchr", number: 395 });
  });

  test("a query or fragment still names the PR", () => {
    expect(githubPrRefFromUrl("https://github.com/o/r/pull/1?tab=files#discussion_r1")).toEqual({ owner: "o", repo: "r", number: 1 });
  });

  test("an issue URL is not a PR URL, and vice versa — the two parsers are mutually exclusive", () => {
    expect(githubPrRefFromUrl("https://github.com/o/r/issues/1")).toBeNull();
    expect(githubIssueRefFromUrl("https://github.com/o/r/pull/1")).toBeNull();
  });

  test("other hosts, schemes, credentials, ports and paths below the PR are all null", () => {
    for (const url of [
      "https://gitlab.com/o/r/pull/1",
      "http://github.com/o/r/pull/1",
      "https://user:pass@github.com/o/r/pull/1",
      "https://github.com:8443/o/r/pull/1",
      "https://github.com/o/r/pull/1/files",
      "not a url",
    ]) expect(githubPrRefFromUrl(url)).toBeNull();
  });
});
