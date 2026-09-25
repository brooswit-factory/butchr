import { describe, expect, test } from "bun:test";
import { canonicalKey, formatResourceRef, parseResourceRef, RESOURCE_REF_PROVIDERS, tryParseResourceRef } from "../../src/resources/resource-ref.js";

describe("parseResourceRef: valid, one per provider", () => {
  test("jira-work-item", () => {
    expect(parseResourceRef("jira-work-item:BUTCHR-123")).toEqual({ provider: "jira-work-item", key: "BUTCHR-123" });
  });
  test("jira-project", () => {
    expect(parseResourceRef("jira-project:BUTCHR")).toEqual({ provider: "jira-project", key: "BUTCHR" });
  });
  test("confluence-page", () => {
    expect(parseResourceRef("confluence-page:123456")).toEqual({ provider: "confluence-page", pageId: "123456" });
  });
  test("github-issue", () => {
    expect(parseResourceRef("github-issue:brooswit-factory/butchr#42")).toEqual({ provider: "github-issue", owner: "brooswit-factory", repo: "butchr", number: 42 });
  });
  test("filesystem", () => {
    expect(parseResourceRef("filesystem:/srv/factory/butchr")).toEqual({ provider: "filesystem", path: "/srv/factory/butchr" });
  });
  test("webpage", () => {
    expect(parseResourceRef("webpage:https://example.com/resource")).toEqual({ provider: "webpage", url: "https://example.com/resource" });
  });
});

describe("parseResourceRef: invalid", () => {
  test("no colon at all", () => {
    expect(() => parseResourceRef("not-a-ref")).toThrow();
  });
  test("unknown provider", () => {
    expect(() => parseResourceRef("zendesk-ticket:acme#1")).toThrow(/unknown resource provider/);
  });
  test("known provider, malformed payload — a specific, actionable message per provider", () => {
    expect(() => parseResourceRef("jira-project:not valid")).toThrow(/invalid jira-project reference/);
    expect(() => parseResourceRef("filesystem:relative/path")).toThrow(/invalid filesystem reference/);
    expect(() => parseResourceRef("webpage:not a url")).toThrow(/invalid webpage reference/);
  });
  test("empty payload after the colon", () => {
    expect(() => parseResourceRef("jira-project:")).toThrow();
  });
});

describe("tryParseResourceRef", () => {
  test("mirrors parseResourceRef for valid input", () => {
    expect(tryParseResourceRef("jira-project:BUTCHR")).toEqual({ provider: "jira-project", key: "BUTCHR" });
  });
  test("null (never throws) for anything invalid", () => {
    expect(tryParseResourceRef("not-a-ref")).toBeNull();
    expect(tryParseResourceRef("unknown-provider:x")).toBeNull();
  });
});

describe("formatResourceRef: round-trips every provider's canonical form", () => {
  for (const input of [
    "jira-work-item:BUTCHR-123",
    "jira-project:BUTCHR",
    "confluence-page:123456",
    "github-issue:brooswit-factory/butchr#42",
    "filesystem:/srv/factory/butchr",
    "webpage:https://example.com/resource",
  ]) {
    test(input, () => {
      expect(formatResourceRef(parseResourceRef(input))).toBe(input);
    });
  }
});

describe("canonicalKey: dedup equivalence and non-equivalence, across the whole union", () => {
  test("canonicalKey is exactly formatResourceRef — one mechanism, not two", () => {
    const ref = parseResourceRef("jira-project:butchr");
    expect(canonicalKey(ref)).toBe(formatResourceRef(ref));
  });

  test("two spellings of one jira-work-item are equivalent", () => {
    expect(canonicalKey(parseResourceRef("jira-work-item:butchr-1"))).toBe(canonicalKey(parseResourceRef("jira-work-item:BUTCHR-1")));
  });

  test("a github-issue URL (mixed case) and the bare canonical form for the same issue are equivalent", () => {
    expect(canonicalKey(parseResourceRef("github-issue:https://github.com/Owner/Repo/issues/1"))).toBe(canonicalKey(parseResourceRef("github-issue:owner/repo#1")));
  });

  test("a webpage ref and a confluence-page ref for the SAME real page are NOT equivalent — known, deliberately unresolved aliasing (docs/resource-links.md)", () => {
    const confluence = canonicalKey(parseResourceRef("confluence-page:39518269"));
    const webpage = canonicalKey(parseResourceRef("webpage:https://wroosbit.atlassian.net/wiki/spaces/FACTORY/pages/39518269/Title"));
    expect(confluence).not.toBe(webpage);
  });

  test("refs of different providers sharing a native id never collide — the provider prefix is part of the key", () => {
    expect(canonicalKey(parseResourceRef("confluence-page:42"))).not.toBe(canonicalKey(parseResourceRef("github-issue:x/y#42")));
  });

  test("different resources of the same provider are not equivalent", () => {
    expect(canonicalKey(parseResourceRef("jira-project:BUTCHR"))).not.toBe(canonicalKey(parseResourceRef("jira-project:FACTORY")));
  });
});

test("RESOURCE_REF_PROVIDERS names exactly the epic's six scoped kinds", () => {
  expect(([...RESOURCE_REF_PROVIDERS] as string[]).sort()).toEqual(["confluence-page", "filesystem", "github-issue", "jira-project", "jira-work-item", "webpage"].sort());
});
