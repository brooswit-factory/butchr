import { describe, expect, test } from "bun:test";
import {
  capLinkedItems,
  descriptionItems,
  discoverLinkedItems,
  issuelinkItems,
  parentItems,
  remoteLinkItems,
  type LinkedItem,
} from "../../src/resources/linked-discovery.js";
import type { IssueLink, JiraRemoteLink } from "../../src/atlassian/types.js";

const link = (type: string, otherEnd: "inward" | "outward", key: string): IssueLink => ({ type, otherEnd, key });
const remote = (url: string, over: Partial<JiraRemoteLink> = {}): JiraRemoteLink =>
  ({ id: "1", globalId: null, relationship: null, url, title: "a link", applicationType: null, ...over });

describe("issuelinkItems: every Jira issuelinks entry, any type, both directions", () => {
  test("a NON-Implements type, both directions", () => {
    expect(issuelinkItems([link("Blocks", "outward", "BUTCHR-1"), link("Blocks", "inward", "BUTCHR-2")])).toEqual([
      { kind: "issuelink", target: "BUTCHR-1" },
      { kind: "issuelink", target: "BUTCHR-2" },
    ]);
  });
  test("Implements is included too — unlike routes.ts's watchedKeys, nothing here is filtered by type", () => {
    expect(issuelinkItems([link("Implements", "outward", "BUTCHR-3")])).toEqual([{ kind: "issuelink", target: "BUTCHR-3" }]);
  });
  test("no links -> nothing", () => {
    expect(issuelinkItems([])).toEqual([]);
  });
});

describe("parentItems: the native Jira parent (Epic)", () => {
  test("a parent key", () => {
    expect(parentItems("BUTCHR-421")).toEqual([{ kind: "parent", target: "BUTCHR-421" }]);
  });
  test("null or undefined -> nothing", () => {
    expect(parentItems(null)).toEqual([]);
    expect(parentItems(undefined)).toEqual([]);
  });
});

describe("remoteLinkItems: every Jira remote issue link", () => {
  test("a remote link", () => {
    expect(remoteLinkItems([remote("https://example.com/doc")])).toEqual([{ kind: "remote-link", target: "https://example.com/doc" }]);
  });
  test("no links -> nothing", () => {
    expect(remoteLinkItems([])).toEqual([]);
  });
});

describe("descriptionItems: URLs and Jira keys in free text", () => {
  test("a Confluence page URL", () => {
    const description = "Design: https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/38469685/Design";
    expect(descriptionItems(description)).toEqual([{ kind: "confluence", target: "https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/38469685/Design" }]);
  });

  test("a GitHub issue URL", () => {
    const description = "See https://github.com/brooswit-factory/butchr/issues/42 for context.";
    expect(descriptionItems(description)).toEqual([{ kind: "github-issue", target: "brooswit-factory/butchr#42" }]);
  });

  test("a GitHub PR URL", () => {
    const description = "Fixed by https://github.com/brooswit-factory/butchr/pull/395.";
    expect(descriptionItems(description)).toEqual([{ kind: "github-pr", target: "brooswit-factory/butchr#395" }]);
  });

  test("a generic webpage URL", () => {
    const description = "Background reading: https://example.com/some/docs/page";
    expect(descriptionItems(description)).toEqual([{ kind: "webpage", target: "https://example.com/some/docs/page" }]);
  });

  test("a Jira browse URL is a jira-key, not a webpage", () => {
    const description = "Related: https://wroosbit.atlassian.net/browse/BUTCHR-426";
    expect(descriptionItems(description)).toEqual([{ kind: "jira-key", target: "BUTCHR-426" }]);
  });

  test("a bare Jira key mentioned in text (no URL) is still found", () => {
    expect(descriptionItems("See BUTCHR-426 for the story.")).toEqual([{ kind: "jira-key", target: "BUTCHR-426" }]);
  });

  test("most-specific-kind-wins: a GitHub PR URL is classified once, as a PR link, never also a webpage", () => {
    const items = descriptionItems("https://github.com/brooswit-factory/butchr/pull/395");
    expect(items).toEqual([{ kind: "github-pr", target: "brooswit-factory/butchr#395" }]);
    expect(items.some((i) => i.kind === "webpage")).toBe(false);
  });

  test("trailing prose punctuation is trimmed off the URL", () => {
    expect(descriptionItems("See https://example.com/page.")).toEqual([{ kind: "webpage", target: "https://example.com/page" }]);
    expect(descriptionItems("(https://example.com/page)")).toEqual([{ kind: "webpage", target: "https://example.com/page" }]);
  });

  test("a local filesystem path never matches", () => {
    expect(descriptionItems("logs are at /var/log/butchr/daemon.log")).toEqual([]);
    expect(descriptionItems("the config lives at C:\\Users\\me\\config.json")).toEqual([]);
    expect(descriptionItems("relative path: ./scripts/build.ts")).toEqual([]);
  });

  test("empty description -> nothing", () => {
    expect(descriptionItems("")).toEqual([]);
  });
});

describe("discoverLinkedItems: combined, de-duplicated set", () => {
  test("combines every source in order: issuelinks, parent, remote links, description", () => {
    expect(discoverLinkedItems({
      issuelinks: [link("Blocks", "outward", "BUTCHR-1")],
      parent: "BUTCHR-421",
      remoteLinks: [remote("https://example.com/doc")],
      description: "See https://github.com/brooswit-factory/butchr/issues/42",
    })).toEqual([
      { kind: "issuelink", target: "BUTCHR-1" },
      { kind: "parent", target: "BUTCHR-421" },
      { kind: "remote-link", target: "https://example.com/doc" },
      { kind: "github-issue", target: "brooswit-factory/butchr#42" },
    ]);
  });

  test("de-dup: the same target reached two ways collapses to one entry, first occurrence's kind wins", () => {
    const items = discoverLinkedItems({
      issuelinks: [link("Relates", "outward", "BUTCHR-426")],
      description: "as discussed on BUTCHR-426",
    });
    expect(items).toEqual([{ kind: "issuelink", target: "BUTCHR-426" }]);
  });

  test("de-dup: the same URL mentioned twice in the description collapses to one entry", () => {
    const items = discoverLinkedItems({ description: "https://example.com/x and again https://example.com/x" });
    expect(items).toEqual([{ kind: "webpage", target: "https://example.com/x" }]);
  });

  test("every field is independently optional; an empty source is an empty set", () => {
    expect(discoverLinkedItems({})).toEqual([]);
  });

  // BUTCHR-431: a description mentioning the resource's OWN key must not be
  // reported as a link to itself.
  describe("ownKey: excluding a self-reference", () => {
    test("a bare mention of the resource's own key in its own description is excluded", () => {
      expect(discoverLinkedItems({ description: "See BUTCHR-426 for context.", ownKey: "BUTCHR-426" })).toEqual([]);
    });
    test("a Jira browse URL pointing at the resource's own key is excluded too", () => {
      expect(discoverLinkedItems({ description: "https://wroosbit.atlassian.net/browse/BUTCHR-426", ownKey: "BUTCHR-426" })).toEqual([]);
    });
    test("other keys/links in the same description are unaffected", () => {
      expect(discoverLinkedItems({ description: "BUTCHR-426 relates to BUTCHR-1.", ownKey: "BUTCHR-426" })).toEqual([{ kind: "jira-key", target: "BUTCHR-1" }]);
    });
    test("omitting ownKey applies no filter at all — the resource's own key (if mentioned) passes through", () => {
      expect(discoverLinkedItems({ description: "See BUTCHR-426 for context." })).toEqual([{ kind: "jira-key", target: "BUTCHR-426" }]);
    });
  });
});

describe("capLinkedItems: maxLinkedItems", () => {
  const items: LinkedItem[] = [
    { kind: "issuelink", target: "A-1" },
    { kind: "issuelink", target: "A-2" },
    { kind: "issuelink", target: "A-3" },
    { kind: "issuelink", target: "A-4" },
  ];

  test("undefined max: uncapped, nothing skipped", () => {
    expect(capLinkedItems(items, undefined)).toEqual({ kept: items, skipped: [] });
  });

  test("a max under the real count keeps the first N in order and reports the rest as skipped, never silently dropped", () => {
    expect(capLinkedItems(items, 2)).toEqual({
      kept: [{ kind: "issuelink", target: "A-1" }, { kind: "issuelink", target: "A-2" }],
      skipped: [{ kind: "issuelink", target: "A-3" }, { kind: "issuelink", target: "A-4" }],
    });
  });

  test("a max at or above the real count: uncapped", () => {
    expect(capLinkedItems(items, 4)).toEqual({ kept: items, skipped: [] });
    expect(capLinkedItems(items, 10)).toEqual({ kept: items, skipped: [] });
  });
});
