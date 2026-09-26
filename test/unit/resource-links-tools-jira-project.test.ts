/**
 * FACTORY-5: `resourceLinkTools` (src/tools/resource-links.ts) is
 * UNCHANGED by this story — it already takes an injected `LinkStore`. This
 * file proves the MCP surface works correctly when that `LinkStore` is the
 * routing store wired the same way `src/daemon/index.ts` wires it: a
 * `jira-project:<KEY>` owner reaches the project-property-backed store, and
 * `list_links`/`add_link`/`remove_link` behave identically to the
 * file-store case general coverage already pins
 * (`resource-links-tools.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceLinkTools } from "../../src/tools/resource-links.js";
import { createLinkStore } from "../../src/resources/link-store.js";
import { createRoutingLinkStore } from "../../src/resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../../src/resources/jira-project-link-store.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import type { ToolDef } from "@brooswit/thatch";

const conn = { headers: {} } as any;

function fakeOps(properties: Map<string, unknown>): AtlassianOps {
  const unimplemented = (name: string) => async (..._a: unknown[]) => { throw new Error(`fake ops: ${name} not used by this test`); };
  return {
    getIssue: unimplemented("getIssue"), search: unimplemented("search"), addComment: unimplemented("addComment"),
    linkIssues: unimplemented("linkIssues"), transition: unimplemented("transition"), createIssue: unimplemented("createIssue"),
    setPriority: unimplemented("setPriority"), assign: unimplemented("assign"), correctText: unimplemented("correctText"),
    createPage: unimplemented("createPage"), getPage: unimplemented("getPage"), updatePage: unimplemented("updatePage") as unknown as AtlassianOps["updatePage"],
    searchPages: unimplemented("searchPages"), listSpaces: unimplemented("listSpaces"),
    getProjectProperty: unimplemented("getProjectProperty"),
    getProjectPropertyOrNull: async (projectKey: string) => properties.get(projectKey) ?? null,
    getRemoteLink: unimplemented("getRemoteLink"), upsertRemoteLink: unimplemented("upsertRemoteLink"),
    getChildPages: unimplemented("getChildPages") as unknown as AtlassianOps["getChildPages"],
    getPageLabels: unimplemented("getPageLabels") as unknown as AtlassianOps["getPageLabels"],
    createPageWithLabel: unimplemented("createPageWithLabel") as unknown as AtlassianOps["createPageWithLabel"],
    addLabels: unimplemented("addLabels"), removeLabels: unimplemented("removeLabels"), deleteIssue: unimplemented("deleteIssue"),
    commentOnPage: unimplemented("commentOnPage"), getPageComments: unimplemented("getPageComments") as unknown as AtlassianOps["getPageComments"],
    searchProjects: unimplemented("searchProjects") as unknown as AtlassianOps["searchProjects"],
    getMyself: unimplemented("getMyself") as unknown as AtlassianOps["getMyself"],
    setProjectProperty: async (projectKey: string, _propertyKey: string, value: unknown) => { properties.set(projectKey, value); return { ok: true }; },
    getPageVersions: unimplemented("getPageVersions") as unknown as AtlassianOps["getPageVersions"],
    getIssueComments: unimplemented("getIssueComments") as unknown as AtlassianOps["getIssueComments"],
  };
}

let dir: string;
let tools: Record<string, ToolDef<any>>;
let properties: Map<string, unknown>;

function setup() {
  dir = mkdtempSync(join(tmpdir(), "butchr-resource-links-tools-jira-project-"));
  properties = new Map();
  const fileStore = createLinkStore(join(dir, "links.json"));
  tools = resourceLinkTools(createRoutingLinkStore({ fileStore, jiraProjectStore: () => createJiraProjectLinkStore(fakeOps(properties)) }), () => {});
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a jira-project owner", () => {
  test("list_links is empty before anything is added", async () => {
    setup();
    const result = await tools.list_links!.handler({ resource: "jira-project:BUTCHR" }, conn);
    expect(result).toEqual({ resource: "jira-project:BUTCHR", links: [] });
  });

  test("add_link then list_links reflects it, and the write landed on the project property (not the file store)", async () => {
    setup();
    const added = await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(added).toEqual({ added: true });
    const result = await tools.list_links!.handler({ resource: "jira-project:BUTCHR" }, conn);
    expect(result).toEqual({ resource: "jira-project:BUTCHR", links: ["confluence-page:1"] });
    expect(properties.get("BUTCHR")).toEqual({ v: 1, links: ["confluence-page:1"] });
  });

  test("idempotent add and non-destructive remove behave identically to the file-store case", async () => {
    setup();
    await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    const secondAdd = await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(secondAdd).toEqual({ added: false, reason: "already-present" });

    const removed = await tools.remove_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(removed).toEqual({ removed: true });
    const secondRemove = await tools.remove_link!.handler({ resource: "jira-project:BUTCHR", target: "confluence-page:1" }, conn);
    expect(secondRemove).toEqual({ removed: false, reason: "not-present" });
  });

  test("a self-link is refused before any store call — no property write", async () => {
    setup();
    await expect(tools.add_link!.handler({ resource: "jira-project:BUTCHR", target: "jira-project:butchr" }, conn)).rejects.toThrow();
    expect(properties.has("BUTCHR")).toBe(false);
  });

  test("any target kind of the six may target a jira-project owner", async () => {
    setup();
    for (const target of ["jira-work-item:BUTCHR-1", "confluence-page:1", "github-issue:owner/repo#1", "filesystem:/srv/x", "webpage:https://example.com/x"]) {
      const result = await tools.add_link!.handler({ resource: "jira-project:BUTCHR", target }, conn);
      expect(result).toEqual({ added: true });
    }
    const result = (await tools.list_links!.handler({ resource: "jira-project:BUTCHR" }, conn)) as { links: string[] };
    expect(result.links).toHaveLength(5);
  });
});
