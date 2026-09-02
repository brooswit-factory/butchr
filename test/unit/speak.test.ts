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

function makeOps(overrides: Partial<AtlassianOps> = {}): { ops: AtlassianOps; jiraComments: Array<{ key: string; text: string }>; pageComments: Array<{ pageId: string; body: string }> } {
  const jiraComments: Array<{ key: string; text: string }> = [];
  const pageComments: Array<{ pageId: string; body: string }> = [];
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
    createPage: async () => ({}),
    getPage: async (id: string) => ({ title: "root doc", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
    updatePage: async () => ({ ok: true }),
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    getProjectProperty: async () => ({ space: { key: "BUTCHR" }, rootDoc: { id: "42" } }),
    getRemoteLink: async () => null,
    upsertRemoteLink: async () => ({}),
    getChildPages: async () => ({ results: [] }),
    getPageLabels: async () => [],
    createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),
    commentOnPage: async (pageId: string, body: string) => {
      pageComments.push({ pageId, body });
      return { ok: true };
    },
    getPageComments: async () => ({ results: [] }),
    ...overrides,
  };
  return { ops, jiraComments, pageComments };
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
});
