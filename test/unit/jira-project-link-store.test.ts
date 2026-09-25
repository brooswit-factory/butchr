import { describe, expect, test } from "bun:test";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import { createJiraProjectLinkStore, JIRA_PROJECT_LINKS_PROPERTY_KEY, JIRA_PROJECT_LINKS_STORE_VERSION } from "../../src/resources/jira-project-link-store.js";

/** Every AtlassianOps member this store never calls, throwing loudly if it ever does — a call reaching one here is a test bug, not a passing behaviour. Mirrors `project-resource-type.test.ts`'s own `unimplementedProjectOps` helper. */
function unimplementedOps(overrides: Partial<AtlassianOps> = {}): AtlassianOps {
  const unimplemented = (name: string) => async (..._a: unknown[]) => {
    throw new Error(`fake ops: ${name} not used by this test`);
  };
  return {
    getIssue: unimplemented("getIssue"), search: unimplemented("search"), addComment: unimplemented("addComment"),
    linkIssues: unimplemented("linkIssues"), transition: unimplemented("transition"), createIssue: unimplemented("createIssue"),
    setPriority: unimplemented("setPriority"), assign: unimplemented("assign"), correctText: unimplemented("correctText"),
    createPage: unimplemented("createPage"), getPage: unimplemented("getPage"), updatePage: unimplemented("updatePage") as unknown as AtlassianOps["updatePage"],
    searchPages: unimplemented("searchPages"), listSpaces: unimplemented("listSpaces"),
    getProjectProperty: unimplemented("getProjectProperty"), getProjectPropertyOrNull: unimplemented("getProjectPropertyOrNull"),
    getRemoteLink: unimplemented("getRemoteLink"), upsertRemoteLink: unimplemented("upsertRemoteLink"),
    getChildPages: unimplemented("getChildPages") as unknown as AtlassianOps["getChildPages"],
    getPageLabels: unimplemented("getPageLabels") as unknown as AtlassianOps["getPageLabels"],
    createPageWithLabel: unimplemented("createPageWithLabel") as unknown as AtlassianOps["createPageWithLabel"],
    addLabels: unimplemented("addLabels"), removeLabels: unimplemented("removeLabels"), deleteIssue: unimplemented("deleteIssue"),
    commentOnPage: unimplemented("commentOnPage"), getPageComments: unimplemented("getPageComments") as unknown as AtlassianOps["getPageComments"],
    searchProjects: unimplemented("searchProjects") as unknown as AtlassianOps["searchProjects"],
    getMyself: unimplemented("getMyself") as unknown as AtlassianOps["getMyself"],
    setProjectProperty: unimplemented("setProjectProperty"),
    getPageVersions: unimplemented("getPageVersions") as unknown as AtlassianOps["getPageVersions"],
    getIssueComments: unimplemented("getIssueComments") as unknown as AtlassianOps["getIssueComments"],
    ...overrides,
  };
}

/** A directly-controllable, in-memory `brooswit.butchr.links` property, keyed by project key — `getProjectPropertyOrNull` reads it, `setProjectProperty` writes it (optionally rejecting, to simulate a Jira 4xx/5xx). */
function fakeWorld(initial?: Record<string, unknown>, opts: { failWrite?: Error } = {}) {
  const properties = new Map<string, unknown>();
  if (initial) properties.set("PROJ", initial);
  const writes: unknown[] = [];
  const ops = unimplementedOps({
    getProjectPropertyOrNull: async (projectKey: string, propertyKey: string) => {
      expect(propertyKey).toBe(JIRA_PROJECT_LINKS_PROPERTY_KEY);
      return properties.get(projectKey) ?? null;
    },
    setProjectProperty: async (projectKey: string, propertyKey: string, value: unknown) => {
      expect(propertyKey).toBe(JIRA_PROJECT_LINKS_PROPERTY_KEY);
      if (opts.failWrite) throw opts.failWrite;
      properties.set(projectKey, value);
      writes.push(value);
      return { ok: true };
    },
  });
  return { ops, properties, writes };
}

const owner = "jira-project:PROJ";

describe("missing property", () => {
  test("list resolves empty, never throws, for a project with no property yet", async () => {
    const { ops } = fakeWorld();
    const store = createJiraProjectLinkStore(ops);
    expect(await store.list(owner)).toEqual([]);
  });
});

describe("add", () => {
  test("adds a target and it is then listed", async () => {
    const { ops, properties } = fakeWorld();
    const store = createJiraProjectLinkStore(ops);
    expect(await store.add(owner, "confluence-page:123456")).toBe(true);
    expect(await store.list(owner)).toEqual(["confluence-page:123456"]);
    expect(properties.get("PROJ")).toEqual({ v: JIRA_PROJECT_LINKS_STORE_VERSION, links: ["confluence-page:123456"] });
  });

  test("duplicate add is a no-op: returns false, does not write twice", async () => {
    const { ops, writes } = fakeWorld({ v: 1, links: ["confluence-page:123456"] });
    const store = createJiraProjectLinkStore(ops);
    expect(await store.add(owner, "confluence-page:123456")).toBe(false);
    expect(writes).toEqual([]);
    expect(await store.list(owner)).toEqual(["confluence-page:123456"]);
  });
});

describe("remove", () => {
  test("removes a present target", async () => {
    const { ops } = fakeWorld({ v: 1, links: ["confluence-page:123456", "github-issue:owner/repo#1"] });
    const store = createJiraProjectLinkStore(ops);
    expect(await store.remove(owner, "confluence-page:123456")).toBe(true);
    expect(await store.list(owner)).toEqual(["github-issue:owner/repo#1"]);
  });

  test("removing an absent target is a non-destructive no-op: returns false, does not write", async () => {
    const { ops, writes } = fakeWorld({ v: 1, links: ["confluence-page:123456"] });
    const store = createJiraProjectLinkStore(ops);
    expect(await store.remove(owner, "confluence-page:999")).toBe(false);
    expect(writes).toEqual([]);
    expect(await store.list(owner)).toEqual(["confluence-page:123456"]);
  });
});

describe("version discipline", () => {
  test("refuses to load a version newer than this build supports", async () => {
    const { ops } = fakeWorld({ v: 999, links: [] });
    const store = createJiraProjectLinkStore(ops);
    await expect(store.list(owner)).rejects.toThrow(/newer than this build supports/);
  });

  test("a missing/invalid \"v\" field is refused", async () => {
    const { ops } = fakeWorld({ links: [] });
    const store = createJiraProjectLinkStore(ops);
    await expect(store.list(owner)).rejects.toThrow(/missing or invalid "v" field/);
  });
});

describe("unknown-provider (unparseable) entries", () => {
  test("an entry this build's resource-ref.ts cannot parse survives an add of a DIFFERENT target, byte for byte", async () => {
    const { ops, properties } = fakeWorld({ v: 1, links: ["not-a-valid-canonical-ref", "some-future-provider:xyz"] });
    const store = createJiraProjectLinkStore(ops);
    expect(await store.add(owner, "confluence-page:1")).toBe(true);
    expect(properties.get("PROJ")).toEqual({ v: 1, links: ["not-a-valid-canonical-ref", "some-future-provider:xyz", "confluence-page:1"] });
  });

  test("survives a remove of a different target too", async () => {
    const { ops, properties } = fakeWorld({ v: 1, links: ["not-a-valid-canonical-ref", "confluence-page:1"] });
    const store = createJiraProjectLinkStore(ops);
    expect(await store.remove(owner, "confluence-page:1")).toBe(true);
    expect(properties.get("PROJ")).toEqual({ v: 1, links: ["not-a-valid-canonical-ref"] });
  });
});

describe("size ceiling", () => {
  test("add refuses with a clear error rather than writing an oversize property", async () => {
    const { ops, writes } = fakeWorld({ v: 1, links: [] });
    const store = createJiraProjectLinkStore(ops);
    const huge = `filesystem:/${"x".repeat(40000)}`;
    await expect(store.add(owner, huge)).rejects.toThrow(/32768-byte/);
    expect(writes).toEqual([]);
  });
});

describe("Jira error propagation", () => {
  test("a read failure (not a not-found) propagates uncaught from list", async () => {
    const ops = unimplementedOps({ getProjectPropertyOrNull: async () => { throw new Error("Atlassian 500 on GET ..."); } });
    const store = createJiraProjectLinkStore(ops);
    await expect(store.list(owner)).rejects.toThrow(/Atlassian 500/);
  });

  test("a write failure (e.g. Jira 403) propagates uncaught from add", async () => {
    const { ops } = fakeWorld({ v: 1, links: [] }, { failWrite: new Error("Atlassian 403 on PUT ...") });
    const store = createJiraProjectLinkStore(ops);
    await expect(store.add(owner, "confluence-page:1")).rejects.toThrow(/Atlassian 403/);
  });
});

describe("malformed property", () => {
  test("a non-array \"links\" field is refused with a clear error", async () => {
    const { ops } = fakeWorld({ v: 1, links: "not-an-array" });
    const store = createJiraProjectLinkStore(ops);
    await expect(store.list(owner)).rejects.toThrow(/"links" must be an array of strings/);
  });
});

describe("owner key discipline", () => {
  test("a non-jira-project ownerKey is a wiring-bug refusal, not silently accepted", async () => {
    const { ops } = fakeWorld();
    const store = createJiraProjectLinkStore(ops);
    await expect(store.list("jira-work-item:BUTCHR-1")).rejects.toThrow(/is not a "jira-project:<KEY>" canonical key/);
  });
});
