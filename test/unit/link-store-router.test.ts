import { describe, expect, test } from "bun:test";
import { createRoutingLinkStore, isJiraProjectOwnerKey } from "../../src/resources/link-store-router.js";
import type { LinkStore } from "../../src/resources/link-store.js";

function fakeStore(name: string, calls: string[]): LinkStore {
  return {
    async list(ownerKey) { calls.push(`${name}.list(${ownerKey})`); return [`${name}-target`]; },
    async add(ownerKey, targetKey) { calls.push(`${name}.add(${ownerKey},${targetKey})`); return true; },
    async remove(ownerKey, targetKey) { calls.push(`${name}.remove(${ownerKey},${targetKey})`); return true; },
  };
}

describe("isJiraProjectOwnerKey", () => {
  test("true only for a jira-project: prefixed owner key", () => {
    expect(isJiraProjectOwnerKey("jira-project:BUTCHR")).toBe(true);
    expect(isJiraProjectOwnerKey("jira-work-item:BUTCHR-1")).toBe(false);
    expect(isJiraProjectOwnerKey("confluence-page:1")).toBe(false);
    expect(isJiraProjectOwnerKey("github-issue:owner/repo#1")).toBe(false);
    expect(isJiraProjectOwnerKey("filesystem:/x")).toBe(false);
    expect(isJiraProjectOwnerKey("webpage:https://example.com")).toBe(false);
  });
});

describe("createRoutingLinkStore", () => {
  test("a jira-project owner routes every op to the jira-project store, never the file store", async () => {
    const calls: string[] = [];
    const fileStore = fakeStore("file", calls);
    const jiraProjectStore = fakeStore("jira-project", calls);
    const store = createRoutingLinkStore({ fileStore, jiraProjectStore: () => jiraProjectStore });

    expect(await store.list("jira-project:BUTCHR")).toEqual(["jira-project-target"]);
    expect(await store.add("jira-project:BUTCHR", "confluence-page:1")).toBe(true);
    expect(await store.remove("jira-project:BUTCHR", "confluence-page:1")).toBe(true);
    expect(calls).toEqual([
      "jira-project.list(jira-project:BUTCHR)",
      "jira-project.add(jira-project:BUTCHR,confluence-page:1)",
      "jira-project.remove(jira-project:BUTCHR,confluence-page:1)",
    ]);
  });

  test("every other owner kind routes to the file store and the jira-project factory is NEVER invoked", async () => {
    const calls: string[] = [];
    const fileStore = fakeStore("file", calls);
    let factoryCalls = 0;
    const store = createRoutingLinkStore({
      fileStore,
      jiraProjectStore: () => { factoryCalls++; throw new Error("must not be called for a non-jira-project owner"); },
    });

    for (const owner of ["jira-work-item:BUTCHR-1", "confluence-page:1", "github-issue:owner/repo#1", "filesystem:/x", "webpage:https://example.com"]) {
      expect(await store.list(owner)).toEqual(["file-target"]);
      expect(await store.add(owner, "confluence-page:2")).toBe(true);
      expect(await store.remove(owner, "confluence-page:2")).toBe(true);
    }
    expect(factoryCalls).toBe(0);
    expect(calls.every((c) => c.startsWith("file."))).toBe(true);
    expect(calls).toHaveLength(15);
  });

  test("the jira-project factory is invoked lazily (only when actually routing there), and its own async construction is awaited", async () => {
    const calls: string[] = [];
    const fileStore = fakeStore("file", calls);
    let factoryCalls = 0;
    const store = createRoutingLinkStore({
      fileStore,
      jiraProjectStore: async () => { factoryCalls++; return fakeStore("jira-project", calls); },
    });
    expect(factoryCalls).toBe(0);
    await store.list("jira-work-item:BUTCHR-1");
    expect(factoryCalls).toBe(0);
    await store.list("jira-project:BUTCHR");
    expect(factoryCalls).toBe(1);
  });
});
