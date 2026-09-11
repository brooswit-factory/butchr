import { describe, expect, test, mock } from "bun:test";
import { createProjectResourceType, projectVerdict } from "../../src/resources/project.js";
import type { ProjectResourceDeps } from "../../src/resources/project.js";

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

// ===========================================================================
// BUTCHR-309 — both project-tier comment readers paginated to exhaustion.
// A fixture that only ever returns one page proves nothing (the ticket's own
// words) — every describe below drives a fake transport that GENUINELY
// returns more than one page, and asserts the ACTUAL PARAMETERS passed on
// each call, not just the final aggregated list: a misspelled parameter key
// (e.g. `limitt`/`nextCursor`) is not a type error or a runtime error here —
// confluence.js/jira.js pick parameters by exact name and `wiki`/`jira` are
// typed `any` in atlassian-real.ts, so a typo is silently dropped and the
// endpoint returns its default first page, behaviourally identical to the
// unfixed bug (see this ticket's pre-start addendum). Only a parameter-level
// assertion, not a count-based one, can catch that.
// ===========================================================================
describe("realAtlassian getPageComments pagination (BUTCHR-309)", () => {
  test("first call carries limit and no cursor; the follow-up carries the cursor parsed from _links.next — captures the ACTUAL parameters, not just the final list", async () => {
    const calls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        comment: {
          getPageFooterComments: (parameters: unknown) => {
            calls.push(parameters);
            if (calls.length === 1) {
              return Promise.resolve({
                results: [{ id: "1", body: { storage: { value: "a" } }, version: {} }],
                _links: { next: "/wiki/api/v2/pages/42/footer-comments?cursor=CURSOR_ABC&limit=250" },
              });
            }
            return Promise.resolve({ results: [{ id: "2", body: { storage: { value: "b" } }, version: {} }] }); // no _links.next -> stop
          },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getPageComments("42");
    expect(calls).toEqual([
      { id: "42", bodyFormat: "storage", limit: 250 }, // first call: no cursor
      { id: "42", bodyFormat: "storage", limit: 250, cursor: "CURSOR_ABC" }, // follow-up: the PARSED cursor, not the raw URL
    ]);
    expect(got).toEqual({ results: [{ id: "1", body: "a" }, { id: "2", body: "b" }] }); // both pages' comments, aggregated
  });

  test("a comment that exists ONLY on page 2 is still returned — a fixture that only ever returns one page would not exercise this", async () => {
    let call = 0;
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        comment: {
          getPageFooterComments: () => {
            call++;
            if (call === 1) return Promise.resolve({ results: [{ id: "1", body: { storage: { value: "" } }, version: {} }], _links: { next: "/x?cursor=NEXT" } });
            return Promise.resolve({ results: [{ id: "2", body: { storage: { value: "" } }, version: {} }] });
          },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getPageComments("42");
    expect(got.results.map((r) => r.id)).toEqual(["1", "2"]);
  });

  test("MAX_COMMENT_PAGES guards a malformed, never-terminating cursor: THROWS rather than returning a silently truncated list (DoD 5)", async () => {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        comment: {
          // ALWAYS returns another cursor — a malformed/never-terminating walk.
          getPageFooterComments: () =>
            Promise.resolve({ results: [{ id: "x", body: { storage: { value: "" } }, version: {} }], _links: { next: "/x?cursor=LOOP" } }),
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    await expect(ops.getPageComments("42")).rejects.toThrow(/exceeded 100 pages/);
  });

  // BUTCHR-309 REVIEW ROUND 1 (measured against the pre-fix code): a
  // `_links.next` that IS present but whose `cursor` query parameter does
  // not parse (an API change, or a next-link shape this parse misses) used
  // to collapse to the SAME `cursor = undefined` as "no next link at all",
  // so the walk silently stopped and returned one page as if it were
  // complete. FALSIFIER: if this ever resolves instead of rejecting, or
  // resolves having silently returned only the first page's results, the
  // present-but-unparseable case has regressed back to "treated as done".
  test("REVIEW FIX: a `next` link present but with NO parseable `cursor` THROWS — 'more data exists' must never read as 'pagination complete'", async () => {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {},
        comment: {
          // `_links.next` IS present, but its query string carries no
          // `cursor` param at all — an unparseable-for-our-purposes next link.
          getPageFooterComments: () =>
            Promise.resolve({
              results: [{ id: "1", body: { storage: { value: "" } }, version: {} }],
              _links: { next: "/wiki/api/v2/pages/42/footer-comments?limit=250" },
            }),
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    await expect(ops.getPageComments("42")).rejects.toThrow(/no `cursor` query parameter could be parsed/);
  });
});

describe("realAtlassian getIssueComments pagination (BUTCHR-309)", () => {
  test("paginates via startAt/maxResults, bounded by the response's own `total` — captures the ACTUAL parameters passed on each page", async () => {
    const calls: unknown[] = [];
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        issueComments: {
          getComments: (parameters: unknown) => {
            calls.push(parameters);
            if (calls.length === 1) {
              return Promise.resolve({ comments: Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) })), total: 125, startAt: 0, maxResults: 100 });
            }
            return Promise.resolve({ comments: Array.from({ length: 25 }, (_, i) => ({ id: String(i + 101) })), total: 125, startAt: 100, maxResults: 100 });
          },
        },
      }),
      isNotFoundError: () => false,
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getIssueComments("KAN-9");
    expect(calls).toEqual([
      { issueIdOrKey: "KAN-9", orderBy: "-created", startAt: 0, maxResults: 100 },
      { issueIdOrKey: "KAN-9", orderBy: "-created", startAt: 100, maxResults: 100 },
    ]);
    expect(got.results.length).toBe(125); // past the OLD 20-item cap, and past a single 100-item page
    expect(got.results.map((r) => r.id)).toContain("125");
  });

  test("MAX_COMMENT_PAGES guards a `total` that never gets reached: THROWS rather than returning a silently truncated list (DoD 5)", async () => {
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        // ALWAYS a full (100-item) page, so the short-page stop never fires
        // — and a `total` far beyond what any page ever delivers, so the
        // startAt < total loop condition never naturally terminates either.
        issueComments: { getComments: () => Promise.resolve({ comments: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })), total: 100_000 }) },
      }),
      isNotFoundError: () => false,
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    await expect(ops.getIssueComments("KAN-9")).rejects.toThrow(/exceeded 100 pages/);
  });

  // BUTCHR-309 REVIEW ROUND 1 (measured against the pre-fix code, not
  // reasoned out of the source): a response with NO numeric `total` field
  // used to make the loop set `total = results.length` as a fallback, which
  // made `startAt < total` false on the very next check — so a 250-comment
  // issue, paginated in pages of 100/100/50 with `total` NEVER reported,
  // silently returned only the first 100. FALSIFIER: if this ever regresses
  // to fewer than 250 results (or fewer than 3 calls), the no-`total`
  // fallback has broken again.
  test("REVIEW FIX: a response with no `total` field still paginates to exhaustion, stopping on the first SHORT page (not the immediate next check)", async () => {
    const calls: unknown[] = [];
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        issueComments: {
          getComments: (parameters: unknown) => {
            calls.push(parameters);
            const sizes = [100, 100, 50];
            const size = sizes[calls.length - 1] ?? 0;
            // NO `total` field anywhere in any of these responses.
            return Promise.resolve({ comments: Array.from({ length: size }, (_, i) => ({ id: `${calls.length}-${i}` })) });
          },
        },
      }),
      isNotFoundError: () => false,
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getIssueComments("KAN-9");
    expect(calls.length).toBe(3); // did NOT stop after page 1
    expect(got.results.length).toBe(250); // the full 100+100+50, not just the first 100
  });

  // BUTCHR-309 REVIEW ROUND 2 (measured against the round-1 fix, not
  // reasoned out of the source): Jira caps `maxResults` SERVER-SIDE and
  // reports the effective value back in the response's own `maxResults`
  // field — a page measured "short" against the REQUESTED size (PAGE_SIZE)
  // rather than the size the server actually honoured looks identical to a
  // genuine last page. FALSIFIER: if this ever returns fewer than 125
  // results, or stops after 1 call, the yardstick has regressed back to
  // "requested size" instead of "server-reported size".
  test("REVIEW FIX ROUND 2: a server that caps `maxResults` below what was requested (but reports its own effective size and a `total`) still paginates to exhaustion", async () => {
    const calls: unknown[] = [];
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        issueComments: {
          getComments: (parameters: unknown) => {
            calls.push(parameters);
            // The server honours only 50 per page regardless of the
            // requested `maxResults: 100`, and says so via its own
            // `maxResults` in the response — the same shape jira.js's
            // PageOfCommentsSchema declares.
            const startAt = (parameters as { startAt: number }).startAt;
            const remaining = Math.max(0, 125 - startAt);
            const size = Math.min(50, remaining);
            return Promise.resolve({
              comments: Array.from({ length: size }, (_, i) => ({ id: `${startAt + i}` })),
              total: 125,
              startAt,
              maxResults: 50,
            });
          },
        },
      }),
      isNotFoundError: () => false,
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const got = await ops.getIssueComments("KAN-9");
    expect(calls.length).toBe(3); // 50 + 50 + 25, not stopped after the first capped-at-50 page
    expect(got.results.length).toBe(125); // the FULL 125, not just the first capped page of 50
  });
});

// ===========================================================================
// DoD 6(a) — the RECOMMENDED shape: drive the REAL `realAtlassian` ops (over
// a mocked multi-page transport) into `createProjectResourceType`'s deps, so
// one test exercises both the real pagination AND the real verdict/decision
// path, not a fake reader standing in for either.
// ===========================================================================
describe("realAtlassian pagination wired into the real project-tier decision path (BUTCHR-309 DoD 6a)", () => {
  function rigMultiPageWorld(opts: { commentsSeen: string[] }) {
    let footerCall = 0;
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: { getPages: () => Promise.resolve({ results: [] }) }, // version axis untouched by this ticket; absent is fine (observedVersion -> null)
        comment: {
          getPageFooterComments: () => {
            footerCall++;
            if (footerCall === 1) {
              return Promise.resolve({ results: [{ id: "100", body: { storage: { value: "" } }, version: {} }], _links: { next: "/x?cursor=NEXT" } });
            }
            return Promise.resolve({ results: [{ id: "200", body: { storage: { value: "" } }, version: {} }] }); // exists ONLY on page 2
          },
        },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        projects: { searchProjects: () => Promise.resolve({ values: [{ key: "ACME", name: "Acme", lead: { accountId: "acct-A" } }] }) },
        myself: { getCurrentUser: () => Promise.resolve({ accountId: "acct-A" }) },
        projectProperties: {
          getProjectProperty: () =>
            Promise.resolve({ value: { space: { key: "ACME" }, rootDoc: { id: "doc-A" }, wake: { commentsSeen: opts.commentsSeen, epicsSeen: {} } } }),
        },
      }),
      isNotFoundError: () => false,
    }));
    return () => footerCall;
  }

  test("(a) a comment that exists ONLY on page 2 wakes the project, through the REAL decision path (realAtlassian's pagination + the real projectVerdict)", async () => {
    rigMultiPageWorld({ commentsSeen: ["100"] }); // "100" (page 1) already seen; "200" only exists on page 2
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const deps: ProjectResourceDeps = { ops, search: async () => [], allowlist: new Set(["ACME"]) };
    const [acme] = await createProjectResourceType(deps).discovery.search();
    expect([...acme!.observedCommentIds].sort()).toEqual(["100", "200"]); // BOTH pages observed
    expect(acme!.unseenCommentIds).toEqual(["200"]); // only the page-2-only comment is unseen
    expect(projectVerdict(acme!)).toBe("active"); // and it wakes the REAL verdict function
  });

  test("(c) re-observing already-seen ids across BOTH pages does NOT wake — the mechanism is genuinely membership-based, not \"any page-2 read wakes\"", async () => {
    rigMultiPageWorld({ commentsSeen: ["100", "200"] }); // BOTH already seen, including the page-2-only one
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const deps: ProjectResourceDeps = { ops, search: async () => [], allowlist: new Set(["ACME"]) };
    const [acme] = await createProjectResourceType(deps).discovery.search();
    expect([...acme!.observedCommentIds].sort()).toEqual(["100", "200"]);
    expect(acme!.unseenCommentIds).toEqual([]);
    expect(projectVerdict(acme!)).toBe("asleep");
  });
});

describe("realAtlassian epic-axis pagination wired into the real project-tier decision path (BUTCHR-309 DoD 6d)", () => {
  function rigEpicWorld(opts: { epicCommentsSeen: readonly string[] }) {
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: { getPages: () => Promise.resolve({ results: [] }) },
        comment: { getPageFooterComments: () => Promise.resolve({ results: [] }) },
      }),
      createV1Client: () => ({ search: { searchByCQL: () => Promise.resolve({ results: [] }) } }),
    }));
    mock.module("jira.js", () => ({
      createCloudClient: () => ({
        projects: { searchProjects: () => Promise.resolve({ values: [{ key: "ACME", name: "Acme", lead: { accountId: "acct-A" } }] }) },
        myself: { getCurrentUser: () => Promise.resolve({ accountId: "acct-A" }) },
        projectProperties: {
          getProjectProperty: () =>
            Promise.resolve({ value: { space: { key: "ACME" }, rootDoc: { id: "doc-A" }, wake: { commentsSeen: [], epicsSeen: { "ACME-1": opts.epicCommentsSeen } } } }),
        },
        // 21 comments — one MORE than the pre-BUTCHR-309 20-item cap — all
        // returned on a SINGLE Jira page (maxResults: 100 now), `total: 21`
        // stops the loop after page 1.
        issueComments: { getComments: () => Promise.resolve({ comments: Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1) })), total: 21 }) },
      }),
      isNotFoundError: () => false,
    }));
  }

  test("(d) the 21st (past the OLD 20-item newest-first cap) epic comment is observed and wakes the real verdict, once seen it does not", async () => {
    rigEpicWorld({ epicCommentsSeen: [] });
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const deps: ProjectResourceDeps = {
      ops,
      search: async () => [{ key: "ACME-1", summary: "e", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] }],
      allowlist: new Set(["ACME"]),
    };
    const [acme] = await createProjectResourceType(deps).discovery.search();
    expect(acme!.observedEpics[0]!.commentIds.length).toBe(21);
    expect(acme!.unseenEpicCommentIds["ACME-1"]).toEqual(expect.arrayContaining(Array.from({ length: 21 }, (_, i) => String(i + 1))));
    expect(projectVerdict(acme!)).toBe("active");
  });

  test("(d continued) all 21 already seen -> asleep, proving this is genuine membership, not a page-count heuristic", async () => {
    rigEpicWorld({ epicCommentsSeen: Array.from({ length: 21 }, (_, i) => String(i + 1)) });
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    const deps: ProjectResourceDeps = {
      ops,
      search: async () => [{ key: "ACME-1", summary: "e", status: "In Review", issuetype: "Epic", assignee: null, parent: null, updated: "", labels: [] }],
      allowlist: new Set(["ACME"]),
    };
    const [acme] = await createProjectResourceType(deps).discovery.search();
    expect(acme!.unseenEpicCommentIds["ACME-1"]).toEqual([]);
    expect(projectVerdict(acme!)).toBe("asleep");
  });
});
