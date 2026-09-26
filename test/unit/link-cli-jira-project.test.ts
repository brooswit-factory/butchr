/**
 * FACTORY-5: CLI coverage specific to a `jira-project:<KEY>` owner —
 * credential loading (lazy, env-based) and Jira-error surfacing. General
 * CLI dispatch behaviour (usage, argument counts, file-store errors) is
 * already covered by `link-cli.test.ts` and untouched by this story.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCli, jiraProjectStoreFromEnv, type LinkCliIo } from "../../src/cli/link-cli.js";
import { createLinkStore } from "../../src/resources/link-store.js";
import { createRoutingLinkStore } from "../../src/resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../../src/resources/jira-project-link-store.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

let dir: string;
let io: LinkCliIo;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-link-cli-jira-project-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credential-missing path", () => {
  const ATLASSIAN_KEYS = ["ATLASSIAN_SITE", "ATLASSIAN_EMAIL", "ATLASSIAN_TOKEN", "ATLASSIAN_TOKEN_FILE"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ATLASSIAN_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ATLASSIAN_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ATLASSIAN_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("jiraProjectStoreFromEnv itself throws a clear error with no Jira credentials configured", () => {
    expect(() => jiraProjectStoreFromEnv()).toThrow(/ATLASSIAN_(SITE|EMAIL|TOKEN)/);
  });

  test("a jira-project CLI call surfaces the missing credential as ONE clean stderr line + exit 1", async () => {
    io = { store: createRoutingLinkStore({ fileStore: createLinkStore(join(dir, "links.json")), jiraProjectStore: jiraProjectStoreFromEnv }), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    expect(await runLinkCli(["list", "jira-project:BUTCHR"], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/butchr link: /);
  });

  test("a NON-jira-project CLI call needs no credentials at all — unaffected by the missing env", async () => {
    io = { store: createRoutingLinkStore({ fileStore: createLinkStore(join(dir, "links.json")), jiraProjectStore: jiraProjectStoreFromEnv }), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    expect(await runLinkCli(["add", "jira-work-item:BUTCHR-1", "confluence-page:1"], io)).toBe(0);
    expect(err).toEqual([]);
  });
});

describe("Jira 4xx/5xx path (credentials present, the underlying Jira call itself fails)", () => {
  function unimplementedOps(overrides: Partial<AtlassianOps> = {}): AtlassianOps {
    const unimplemented = (name: string) => async (..._a: unknown[]) => { throw new Error(`fake ops: ${name} not used by this test`); };
    return {
      getIssue: unimplemented("getIssue"), search: unimplemented("search"), addComment: unimplemented("addComment"),
      linkIssues: unimplemented("linkIssues"), transition: unimplemented("transition"), createIssue: unimplemented("createIssue"),
      setPriority: unimplemented("setPriority"), assign: unimplemented("assign"), correctText: unimplemented("correctText"),
      createPage: unimplemented("createPage"), getPage: unimplemented("getPage"), updatePage: unimplemented("updatePage") as unknown as AtlassianOps["updatePage"],
      searchPages: unimplemented("searchPages"), listSpaces: unimplemented("listSpaces"),
      getProjectProperty: unimplemented("getProjectProperty"),
      getProjectPropertyOrNull: unimplemented("getProjectPropertyOrNull"),
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

  test("a Jira 403 on the property read surfaces as ONE clean stderr line + exit 1, not an uncaught throw", async () => {
    const ops = unimplementedOps({ getProjectPropertyOrNull: async () => { throw new Error("Atlassian 403 on GET /rest/api/3/project/BUTCHR/properties/brooswit.butchr.links: Forbidden"); } });
    io = { store: createRoutingLinkStore({ fileStore: createLinkStore(join(dir, "links.json")), jiraProjectStore: () => createJiraProjectLinkStore(ops) }), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    expect(await runLinkCli(["list", "jira-project:BUTCHR"], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/Atlassian 403/);
  });

  test("a Jira 500 on the property write (add) surfaces as ONE clean stderr line + exit 1", async () => {
    const ops = unimplementedOps({
      getProjectPropertyOrNull: async () => null,
      setProjectProperty: async () => { throw new Error("Atlassian 500 on PUT /rest/api/3/project/BUTCHR/properties/brooswit.butchr.links: Internal Server Error"); },
    });
    io = { store: createRoutingLinkStore({ fileStore: createLinkStore(join(dir, "links.json")), jiraProjectStore: () => createJiraProjectLinkStore(ops) }), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    expect(await runLinkCli(["add", "jira-project:BUTCHR", "confluence-page:1"], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/Atlassian 500/);
  });
});
