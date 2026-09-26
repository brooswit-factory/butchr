import { describe, expect, test } from "bun:test";
import type { IssueLink, JiraIssue } from "../../src/atlassian/types.js";
import {
  jiraWorkItemOwnerRef, managedLinkedItems, MANAGED_LINK_KINDS, nativeJiraRefs, resourceRefToLinkedItem,
} from "../../src/resources/link-reconcile.js";
import { addLink } from "../../src/resources/link-store.js";
import type { LinkStore } from "../../src/resources/link-store.js";
import { parseResourceRef, type ResourceRef } from "../../src/resources/resource-ref.js";

/**
 * FACTORY-9 (implements FACTORY-6, epic FACTORY-3, story 3/3): pure-function
 * coverage for `src/resources/link-reconcile.ts` — the module that turns
 * FACTORY-4's merged effective-link set into the `LinkedItem`s
 * `src/jira-watch/linked-eventing.ts`'s existing coalescer/rate-cap/notify
 * machinery already knows how to watch. Integration-level coverage (a real
 * `runTick`, real watcher/baseline reconciliation) lives in
 * test/unit/linked-eventing-managed-links.test.ts.
 */

const ref = (s: string): ResourceRef => parseResourceRef(s);

/** An in-memory `LinkStore` — no filesystem needed for these pure-function-adjacent tests (test/unit/link-store.test.ts already covers the real file-backed implementation). */
function fakeLinkStore(initial: Record<string, string[]> = {}): LinkStore {
  const data: Record<string, string[]> = structuredClone(initial);
  return {
    async list(ownerKey) { return data[ownerKey] ?? []; },
    async add(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (existing.includes(targetKey)) return false;
      data[ownerKey] = [...existing, targetKey];
      return true;
    },
    async remove(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (!existing.includes(targetKey)) return false;
      data[ownerKey] = existing.filter((t) => t !== targetKey);
      return true;
    },
  };
}

const link = (type: string, otherEnd: "inward" | "outward", key: string): IssueLink => ({ type, otherEnd, key });

describe("jiraWorkItemOwnerRef", () => {
  test("this owner's own jira-work-item ResourceRef", () => {
    expect(jiraWorkItemOwnerRef({ key: "BUTCHR-1" })).toEqual({ provider: "jira-work-item", key: "BUTCHR-1" });
  });
});

describe("nativeJiraRefs", () => {
  test("issuelinks and parent become jira-work-item refs", () => {
    const issue = { key: "BUTCHR-1", issuelinks: [link("Blocks", "outward", "BUTCHR-2")], parent: "BUTCHR-9" };
    expect(nativeJiraRefs(issue).map((r) => (r as { key: string }).key).sort()).toEqual(["BUTCHR-2", "BUTCHR-9"]);
  });

  test("de-duplicates by canonical key (case-insensitive) — issuelinks and parent alike", () => {
    const issue = { key: "BUTCHR-1", issuelinks: [link("Blocks", "outward", "butchr-2"), link("Relates", "inward", "BUTCHR-2")], parent: null };
    expect(nativeJiraRefs(issue)).toHaveLength(1);
  });

  test("excludes a self-referential entry", () => {
    const issue = { key: "BUTCHR-1", issuelinks: [link("Blocks", "outward", "BUTCHR-1")], parent: "BUTCHR-1" };
    expect(nativeJiraRefs(issue)).toEqual([]);
  });

  test("missing issuelinks (absent) and null parent produce no refs, never throw", () => {
    expect(nativeJiraRefs({ key: "BUTCHR-1", parent: null })).toEqual([]);
  });
});

describe("resourceRefToLinkedItem", () => {
  test("jira-work-item -> jira-key, target is the bare key", () => {
    expect(resourceRefToLinkedItem(ref("jira-work-item:BUTCHR-9"))).toEqual({ kind: "jira-key", target: "BUTCHR-9" });
  });

  test("confluence-page -> confluence, target is the BARE page id, not a URL", () => {
    expect(resourceRefToLinkedItem(ref("confluence-page:123456"))).toEqual({ kind: "confluence", target: "123456" });
  });

  test("github-issue -> github-issue, target is the canonical owner/repo#n string unchanged", () => {
    expect(resourceRefToLinkedItem(ref("github-issue:brooswit-factory/butchr#42"))).toEqual({ kind: "github-issue", target: "brooswit-factory/butchr#42" });
  });

  test("webpage -> webpage, target is the ref's own normalized URL", () => {
    expect(resourceRefToLinkedItem(ref("webpage:https://example.com/status"))).toEqual({ kind: "webpage", target: "https://example.com/status" });
  });

  test("filesystem -> filesystem, target is the absolute path", () => {
    expect(resourceRefToLinkedItem(ref("filesystem:/srv/factory/butchr"))).toEqual({ kind: "filesystem", target: "/srv/factory/butchr" });
  });

  test("jira-project -> null: an explicit, documented scope gap (no live changeToken source), never a crash", () => {
    expect(resourceRefToLinkedItem(ref("jira-project:BUTCHR"))).toBeNull();
  });

  test("MANAGED_LINK_KINDS names exactly the kinds this function can produce", () => {
    expect([...MANAGED_LINK_KINDS].sort()).toEqual(["confluence", "filesystem", "github-issue", "jira-key", "webpage"]);
  });
});

describe("managedLinkedItems", () => {
  test("a managed-only link (no native overlap) becomes a new LinkedItem", async () => {
    const owner = ref("jira-work-item:BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, owner, ref("confluence-page:999"));
    const items = await managedLinkedItems(owner, [], store);
    expect(items).toEqual([{ kind: "confluence", target: "999" }]);
  });

  test("a managed link duplicating an EXISTING native link is excluded (origin 'both' — already covered by native discovery)", async () => {
    const owner = ref("jira-work-item:BUTCHR-1");
    const nativeRefs = [ref("jira-work-item:BUTCHR-2")];
    const store = fakeLinkStore();
    await addLink(store, owner, ref("jira-work-item:BUTCHR-2")); // same target as the native issuelink
    await addLink(store, owner, ref("jira-work-item:BUTCHR-3")); // genuinely new
    const items = await managedLinkedItems(owner, nativeRefs, store);
    expect(items).toEqual([{ kind: "jira-key", target: "BUTCHR-3" }]); // BUTCHR-2 excluded — jiraKindLinkedItems already reports it as "issuelink"
  });

  test("an unsupported target kind (jira-project) is skipped, logged once, never thrown", async () => {
    const owner = ref("jira-work-item:BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, owner, ref("jira-project:BUTCHR"));
    await addLink(store, owner, ref("webpage:https://example.com/x"));
    const logs: string[] = [];
    const items = await managedLinkedItems(owner, [], store, (l) => logs.push(l));
    expect(items).toEqual([{ kind: "webpage", target: "https://example.com/x" }]);
    expect(logs.some((l) => l.includes("jira-project:BUTCHR") && l.includes("unsupported"))).toBe(true);
  });

  test("no managed links at all -> empty array, one cheap store read", async () => {
    const owner = ref("jira-work-item:BUTCHR-1");
    expect(await managedLinkedItems(owner, [], fakeLinkStore())).toEqual([]);
  });
});
