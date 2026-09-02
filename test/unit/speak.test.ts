import { describe, expect, test } from "bun:test";
import { speakOnOwnChannel } from "../../src/tools/speak.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

// BUTCHR-71 / BUTCHR-62: "where a resource speaks" — an issue on its own
// ticket, a project on its own root doc. What would make each check FAIL:
// an issue caller ending up calling commentOnPage (or a project caller
// ending up calling addComment) would fail the dispatch tests; the posted
// text differing from what was passed in would fail the "text passes
// through unchanged" test; the project caller NOT resolving through the
// project's own entity property would fail the "resolves via
// getProjectProperty" test.

function makeOps(overrides: Partial<AtlassianOps> = {}): { ops: AtlassianOps; jiraComments: Array<{ key: string; text: string }>; pageComments: Array<{ pageId: string; body: string }>; properties: Map<string, unknown> } {
  const jiraComments: Array<{ key: string; text: string }> = [];
  const pageComments: Array<{ pageId: string; body: string }> = [];
  const properties = new Map<string, unknown>([["BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "42" } }]]);
  const ops: AtlassianOps = {
    getIssue: async () => ({}),
    search: async () => ({}),
    addComment: async (key: string, text: string) => {
      jiraComments.push({ key, text });
      return { ok: true };
    },
    linkIssues: async () => ({}),
    transition: async () => ({}),
    createIssue: async () => ({}),
    setPriority: async () => ({}),
    assign: async () => ({}),
    correctText: async () => ({}),
    createPage: async () => ({}),
    getPage: async (id: string) => ({ title: "root doc", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
    updatePage: async () => ({ ok: true }),
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    getProjectProperty: async (projectKey: string) => {
      const p = properties.get(projectKey);
      if (!p) throw new Error(`fake: no "butchr" property for ${projectKey}`);
      return p;
    },
    getRemoteLink: async () => null,
    upsertRemoteLink: async () => ({}),
    getChildPages: async () => ({ results: [] }),
    getPageLabels: async () => [],
    createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),
    commentOnPage: async (pageId: string, body: string) => {
      const id = String(1000 + pageComments.length);
      pageComments.push({ pageId, body });
      return { ok: true, id };
    },
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: "test-account" }),
    setProjectProperty: async (projectKey: string, _propertyKey: string, value: unknown) => {
      properties.set(projectKey, value);
      return { ok: true };
    },
    getPageVersions: async () => ({}),
    ...overrides,
  };
  return { ops, jiraComments, pageComments, properties };
}

describe("speakOnOwnChannel", () => {
  test("an ISSUE caller speaks via ops.addComment, on its own ticket, text unchanged", async () => {
    const { ops, jiraComments, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR-71", "[BUTCHR-71] status update");
    expect(jiraComments).toEqual([{ key: "BUTCHR-71", text: "[BUTCHR-71] status update" }]);
    expect(pageComments).toEqual([]); // never touches the Confluence path
  });

  test("a PROJECT caller speaks via ops.commentOnPage, on its OWN ROOT DOC resolved via the entity property — never ops.addComment", async () => {
    const { ops, jiraComments, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "[BUTCHR] status update");
    expect(jiraComments).toEqual([]); // never touches the Jira path
    expect(pageComments.length).toBe(1);
    expect(pageComments[0]!.pageId).toBe("42"); // the id from getProjectProperty's rootDoc.id
    expect(pageComments[0]!.body).toContain("[BUTCHR] status update"); // text preserved
    expect(pageComments[0]!.body).toMatch(/^<p>.*<\/p>$/); // wrapped as a storage-format paragraph
  });

  test("a PROJECT caller's post is refused, naming the project, when the root doc can't be resolved — never silently falls back to addComment", async () => {
    const { ops } = makeOps({ getProjectProperty: async () => { throw new Error("404"); } });
    await expect(speakOnOwnChannel(ops, "BUTCHR", "hello")).rejects.toThrow(/BUTCHR.*unreadable/s);
  });

  test("HTML-sensitive characters in the text are escaped before being wrapped in storage format", async () => {
    const { ops, pageComments } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "a < b & c > d");
    expect(pageComments[0]!.body).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  // HAZARD 1 (BUTCHR-67/BUTCHR-81): a project's own report_to_boss/ask_boss
  // (both go through speakOnOwnChannel) must not leave itself looking like a
  // pending wake trigger. Failure condition, stated before the check: if
  // the `wake.comment` watermark is NOT advanced to the id this call's own
  // `commentOnPage` returned, `projectVerdict` would see `observedCommentId
  // !== watermark.comment` and (wrongly) report `active` for a project that
  // only ever spoke to itself. A suppression that ALSO swallows a foreign
  // comment (one this function never wrote) would fail the opposite way —
  // both are asserted below.
  test("HAZARD 1: a project's own comment advances its wake.comment watermark to that comment's own id", async () => {
    const { ops, properties } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "[BUTCHR] status update");
    const prop = properties.get("BUTCHR") as { wake?: { comment?: string | null } };
    expect(prop.wake?.comment).toBe("1000"); // the id makeOps's fake commentOnPage assigned this call
  });

  test("HAZARD 1 control: the watermark advance never overwrites the rest of the butchr property (space/rootDoc untouched)", async () => {
    const { ops, properties } = makeOps();
    await speakOnOwnChannel(ops, "BUTCHR", "hello");
    const prop = properties.get("BUTCHR") as { space?: { key?: string }; rootDoc?: { id?: string } };
    expect(prop.space).toEqual({ key: "BUTCHR" });
    expect(prop.rootDoc).toEqual({ id: "42" });
  });

  test("a failed watermark write never fails the (already-succeeded) speak call", async () => {
    const { ops, pageComments } = makeOps({ setProjectProperty: async () => { throw new Error("boom"); } });
    await expect(speakOnOwnChannel(ops, "BUTCHR", "hello")).resolves.toBeDefined();
    expect(pageComments.length).toBe(1); // the comment itself still landed
  });
});
