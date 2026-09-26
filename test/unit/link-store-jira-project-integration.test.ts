/**
 * FACTORY-5: integration coverage across the three layers the ticket's
 * acceptance criteria name explicitly — the core `listLinks`/`addLink`/
 * `removeLink` functions, the CLI (`runLinkCli`), and the routing decision
 * itself, all wired the same way `src/daemon/index.ts` wires them (a
 * `createRoutingLinkStore` over a real file-backed store and a real
 * `createJiraProjectLinkStore`, the latter fed a fake `AtlassianOps` so no
 * live Jira call is made). Unit-level coverage for the property store's own
 * read/write/version/size-cap logic lives in
 * `jira-project-link-store.test.ts`; unit-level coverage for the routing
 * decision itself lives in `link-store-router.test.ts`. This file is the
 * "does it actually work wired together the way production wires it" check.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLink, createLinkStore, listLinks, type LinkStore } from "../../src/resources/link-store.js";
import { createRoutingLinkStore } from "../../src/resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../../src/resources/jira-project-link-store.js";
import { canonicalKey, parseResourceRef } from "../../src/resources/resource-ref.js";
import { runLinkCli, type LinkCliIo } from "../../src/cli/link-cli.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

const ref = (s: string) => parseResourceRef(s);

/** A fresh `AtlassianOps` backed by a SHARED `properties` map — modelling "a new process/store instance reading the same live Jira project property a prior instance wrote". */
function opsOver(properties: Map<string, unknown>): AtlassianOps {
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
let file: string;
const clean: (() => void)[] = [];
afterEach(() => { rmSync(dir, { recursive: true, force: true }); for (const f of clean.splice(0).reverse()) f(); });

function freshFileStore(): LinkStore {
  dir = mkdtempSync(join(tmpdir(), "butchr-link-store-router-int-"));
  file = join(dir, "links.json");
  return createLinkStore(file);
}

describe("round trip — acceptance criterion", () => {
  test("a link added via the core API AND one added via the CLI both survive a FRESH store instance's resolve", async () => {
    const properties = new Map<string, unknown>();
    const owner = ref("jira-project:PROJ");

    // 1) core API, against its own fresh store instance.
    const store1 = createJiraProjectLinkStore(opsOver(properties));
    const coreResult = await addLink(store1, owner, ref("confluence-page:111"));
    expect(coreResult).toEqual({ ok: true, added: true });

    // 2) CLI entry point, against ANOTHER fresh store instance (routed).
    const fileStore = freshFileStore();
    const io: LinkCliIo = {
      store: createRoutingLinkStore({ fileStore, jiraProjectStore: () => createJiraProjectLinkStore(opsOver(properties)) }),
      stdout: () => {},
      stderr: () => {},
    };
    const cliExit = await runLinkCli(["add", "jira-project:PROJ", "github-issue:owner/repo#42"], io);
    expect(cliExit).toBe(0);

    // 3) a THIRD, completely fresh store/resolver instance — never used for either write above.
    const store3 = createJiraProjectLinkStore(opsOver(properties));
    const links = await listLinks(store3, owner);
    expect(links.map(canonicalKey).sort()).toEqual(["confluence-page:111", "github-issue:owner/repo#42"].sort());

    // Fresh CLI `list`, too — the human-facing path, not just the core one.
    const out: string[] = [];
    const listIo: LinkCliIo = {
      store: createRoutingLinkStore({ fileStore, jiraProjectStore: () => createJiraProjectLinkStore(opsOver(properties)) }),
      stdout: (l) => out.push(l),
      stderr: () => {},
    };
    expect(await runLinkCli(["list", "jira-project:PROJ"], listIo)).toBe(0);
    expect(out.sort()).toEqual(["confluence-page:111", "github-issue:owner/repo#42"].sort());
  });
});

describe("a non-jira-project owner never touches the project property", () => {
  test("routes to the file store; the jira-project factory throws if it's ever invoked, and it never is", async () => {
    const fileStore = freshFileStore();
    const store = createRoutingLinkStore({
      fileStore,
      jiraProjectStore: () => { throw new Error("must not be invoked for a non-jira-project owner"); },
    });
    const owner = ref("jira-work-item:BUTCHR-1");
    const result = await addLink(store, owner, ref("confluence-page:1"));
    expect(result).toEqual({ ok: true, added: true });
    expect(await listLinks(store, owner)).toEqual([ref("confluence-page:1")]);
  });
});
