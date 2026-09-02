import { describe, expect, test, mock } from "bun:test";

describe("realAtlassian confluence page ops", () => {
  test("createPage nests spaceId/status/title/body (+ optional parentId) under `body`, the only key confluence.js 3.2.0 forwards; getPage sends bodyFormat, the key the library actually reads, and adds bodyRequested/bodyLength", async () => {
    const createPageCalls: unknown[] = [];
    const getPageByIdCalls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {
          createPage: (parameters: unknown) => {
            createPageCalls.push(parameters);
            return Promise.resolve({ id: "1" });
          },
          getPageById: (parameters: unknown) => {
            getPageByIdCalls.push(parameters);
            return Promise.resolve({ id: "10682374", body: { storage: { value: "<p>x</p>" } } });
          },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.createPage({ spaceId: "196612", title: "t", body: "<p>x</p>" });
    expect(createPageCalls).toEqual([
      { body: { spaceId: "196612", status: "current", title: "t", body: { representation: "storage", value: "<p>x</p>" } } },
    ]);

    await ops.createPage({ spaceId: "196612", title: "t", body: "<p>x</p>", parentId: "196725" });
    expect(createPageCalls[1]).toEqual({
      body: { spaceId: "196612", status: "current", title: "t", body: { representation: "storage", value: "<p>x</p>" }, parentId: "196725" },
    });

    const got = await ops.getPage("10682374");
    expect(getPageByIdCalls).toEqual([{ id: "10682374", bodyFormat: "storage" }]);
    expect(got).toEqual({ id: "10682374", body: { storage: { value: "<p>x</p>" } }, bodyRequested: true, bodyLength: 8 });
  });

  test("getPage: an empty storage value reports bodyLength: 0 (still bodyRequested: true) — the empty-page/body-not-returned distinction 1d exists for", async () => {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: { getPageById: () => Promise.resolve({ id: "1", body: { storage: { value: "" } } }) },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getPage("1");
    expect(got).toEqual({ id: "1", body: { storage: { value: "" } }, bodyRequested: true, bodyLength: 0 });
  });
});

describe("realAtlassian confluence_update_page (optimistic locking handled internally)", () => {
  test("reads the current version, then PUTs id (top-level, for the URL) + body carrying id/status/title/body/version.number+1 (only `id`/`body` are forwarded by confluence.js 3.2.0's updatePage)", async () => {
    const getPageByIdCalls: unknown[] = [];
    const updatePageCalls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {
          getPageById: (parameters: unknown) => {
            getPageByIdCalls.push(parameters);
            return Promise.resolve({ id: "10715137", title: "Old title", version: { number: 4 } });
          },
          updatePage: (parameters: unknown) => {
            updatePageCalls.push(parameters);
            return Promise.resolve({ id: "10715137", version: { number: 5 } });
          },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.updatePage({ id: "10715137", body: "<p>new</p>" });
    expect(getPageByIdCalls).toEqual([{ id: "10715137", bodyFormat: "storage" }]);
    expect(updatePageCalls).toEqual([{
      id: "10715137",
      body: {
        id: "10715137", status: "current", title: "Old title",
        body: { representation: "storage", value: "<p>new</p>" },
        version: { number: 5, message: "butchr: confluence_update_page" },
      },
    }]);
  });

  test("an explicit title overrides the page's current title instead of keeping it", async () => {
    const updatePageCalls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {
          getPageById: () => Promise.resolve({ id: "1", title: "Old", version: { number: 1 } }),
          updatePage: (parameters: unknown) => { updatePageCalls.push(parameters); return Promise.resolve({}); },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    await ops.updatePage({ id: "1", body: "<p>x</p>", title: "New title" });
    expect((updatePageCalls[0] as { body: { title: string } }).body.title).toBe("New title");
  });
});

describe("realAtlassian confluence_search_pages", () => {
  test("searchPages forwards cql and limit to the v1 client's searchByCQL (no top-level-key gotcha on this endpoint — it reads named GET params directly)", async () => {
    const searchByCQLCalls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({ page: {} }),
      createV1Client: () => ({
        search: {
          searchByCQL: (parameters: unknown) => {
            searchByCQLCalls.push(parameters);
            return Promise.resolve({ results: [{ content: { id: "10715137" }, title: "t", url: "/spaces/SD/pages/10715137" }] });
          },
        },
      }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.searchPages('title ~ "log"', 25);
    expect(searchByCQLCalls).toEqual([{ cql: 'title ~ "log"', limit: 25 }]);
    expect(got).toEqual({ results: [{ content: { id: "10715137" }, title: "t", url: "/spaces/SD/pages/10715137" }] });
  });
});

describe("realAtlassian getPageComments (BUTCHR-171: `created`)", () => {
  test("maps `created` from version.createdAt via .toISOString() — confluence.js's own schema coerces this field to a real Date, never a string, at parse time", async () => {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        // Standing in for confluence.js's OWN schema.safeParse behaviour
        // (MEASURED separately against the real PageFooterCommentsSchema,
        // not re-derived here): `version.createdAt` arrives as a real
        // `Date` object, not an ISO string, because confluence.js declares
        // it `z.ZodCoercedDate` and returns the PARSED response.
        comment: {
          getPageFooterComments: () =>
            Promise.resolve({
              results: [
                { id: "1", body: { storage: { value: "<p>hi</p>" } }, version: { authorId: "acct-1", createdAt: new Date("2026-01-01T00:00:00.000Z") } },
              ],
            }),
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getPageComments("42");
    expect(got).toEqual({ results: [{ id: "1", body: "<p>hi</p>", author: "acct-1", created: "2026-01-01T00:00:00.000Z" }] });
  });

  test("a row with no version (or a version whose createdAt isn't a Date) maps `created` to undefined — never synthesised, never passed through raw", async () => {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        comment: {
          getPageFooterComments: () =>
            Promise.resolve({
              results: [
                { id: "1", body: { storage: { value: "<p>no version at all</p>" } } },
                { id: "2", body: { storage: { value: "<p>createdAt missing</p>" } }, version: { authorId: "acct-2" } },
              ],
            }),
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getPageComments("42");
    expect(got).toEqual({
      results: [
        { id: "1", body: "<p>no version at all</p>" },
        { id: "2", body: "<p>createdAt missing</p>", author: "acct-2" },
      ],
    });
  });
});

describe("realAtlassian correctText (BUTCHR-60)", () => {
  function rigJira() {
    const editIssueCalls: unknown[] = [];
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        issues: {
          editIssue: (p: unknown) => {
            editIssueCalls.push(p);
            return Promise.resolve(undefined); // editIssue's real empty-201-body shape
          },
        },
      }),
      isNotFoundError: () => false,
    }));
    return editIssueCalls;
  }

  test("wraps a non-empty description with adf(), leaves summary a plain string, and writes only the field(s) actually supplied", async () => {
    const editIssueCalls = rigJira();
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.correctText("KAN-9", { description: "new text" });
    expect(editIssueCalls[0]).toEqual({
      issueIdOrKey: "KAN-9",
      fields: { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "new text" }] }] } },
    });

    await ops.correctText("KAN-9", { summary: "new summary" });
    expect(editIssueCalls[1]).toEqual({ issueIdOrKey: "KAN-9", fields: { summary: "new summary" } }); // summary NOT wrapped

    await ops.correctText("KAN-9", { description: "d", summary: "s" });
    expect(editIssueCalls[2]).toEqual({
      issueIdOrKey: "KAN-9",
      fields: {
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }] },
        summary: "s",
      },
    });
  });

  test("an empty-string description emits the valid empty-paragraph ADF form, NOT adf('')'s empty text node (found in review: `adf(\"\")` is not valid ADF and was never measured against the real API)", async () => {
    const editIssueCalls = rigJira();
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.correctText("KAN-9", { description: "" });
    expect(editIssueCalls[0]).toEqual({
      issueIdOrKey: "KAN-9",
      fields: { description: { type: "doc", version: 1, content: [{ type: "paragraph" }] } }, // paragraph with NO content — not { text: "" }
    });
  });

  test("an empty-string summary is passed through UNCHANGED, not refused or dropped here — Jira itself requires a non-empty summary and is left to reject it with its own error (decided in review, BUTCHR-60)", async () => {
    const editIssueCalls = rigJira();
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.correctText("KAN-9", { summary: "" });
    expect(editIssueCalls[0]).toEqual({ issueIdOrKey: "KAN-9", fields: { summary: "" } });
  });
});
