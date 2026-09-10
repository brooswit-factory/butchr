import { describe, expect, test } from "bun:test";
import { ApiError } from "confluence.js/core";
import { getDoc, setDoc, ensureDoc, labelForKey, JIRA_KEY_RE, projectRootDoc, getProjectDoc, setProjectDoc } from "../../src/tools/docs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/**
 * A small stateful Jira+Confluence world implementing the full `AtlassianOps`
 * surface, used only by this file. docs.ts's logic (recursive nested
 * creation, exhaustive child pagination, a race-guard retry) is genuinely
 * stateful across calls in a way the simple call-recording `rig()` in
 * tools.test.ts isn't built for — this fake exists for that reason, not as a
 * second version of that one. Everything docs.ts doesn't touch (search,
 * addComment, …) is stubbed since it's never called.
 */
function makeWorld(opts: { childPageSize?: number } = {}) {
  const childPageSize = opts.childPageSize ?? 50;
  const issues = new Map<string, { summary: string; bossKey?: string; remoteLink?: { title: string; url: string } }>();
  const pages = new Map<string, { parentId: string; title: string; body: string; labels: string[]; version?: number }>();
  const projectProperties = new Map<string, unknown>();
  let nextId = 100;
  let upsertRemoteLinkCalls = 0;

  function addIssue(key: string, summary: string, bossKey?: string) {
    issues.set(key, { summary, ...(bossKey ? { bossKey } : {}) });
  }
  function setProjectProperty(projectKey: string, value: unknown) {
    projectProperties.set(projectKey, value);
  }
  function pageUrl(id: string) {
    return `https://fake.atlassian.net/wiki/pages/${id}`;
  }

  const ops: AtlassianOps = {
    getIssue: async (key: string) => {
      const issue = issues.get(key);
      if (!issue) throw new Error(`fake world: no such issue ${key}`);
      return {
        self: `https://fake.atlassian.net/rest/api/3/issue/${key}`,
        fields: {
          summary: issue.summary,
          issuelinks: issue.bossKey ? [{ type: { name: "Implements" }, inwardIssue: { key: issue.bossKey } }] : [],
        },
      };
    },
    search: async () => ({}),
    addComment: async () => ({}),
    linkIssues: async () => ({}),
    transition: async () => ({}),
    createIssue: async () => ({}),
    setPriority: async () => ({}),
    assign: async () => ({}),
    correctText: async () => ({}),
    createPage: async () => ({}),
    getPage: async (id: string) => {
      const p = pages.get(id);
      if (!p) throw new Error(`fake world: no such page ${id}`);
      return { title: p.title, body: { storage: { value: p.body } }, version: { number: p.version ?? 1 }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } };
    },
    updatePage: async (p) => {
      const page = pages.get(p.id);
      if (!page) throw new Error(`fake world: no such page ${p.id}`);
      page.body = p.body;
      if (p.title) page.title = p.title;
      page.version = (page.version ?? 1) + 1;
      return { ok: true };
    },
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),

    getProjectProperty: async (projectKey: string) => {
      const v = projectProperties.get(projectKey);
      if (!v) throw new Error(`fake world: no "butchr" property for project ${projectKey}`);
      return v;
    },
    getRemoteLink: async (key: string) => {
      const issue = issues.get(key);
      return issue?.remoteLink ? { object: { ...issue.remoteLink } } : null;
    },
    upsertRemoteLink: async (key: string, _globalId: string, _relationship: string, object: { title: string; url: string }) => {
      upsertRemoteLinkCalls++;
      const issue = issues.get(key);
      if (!issue) throw new Error(`fake world: no such issue ${key}`);
      issue.remoteLink = { ...object };
      return { id: 1 };
    },
    getChildPages: async (parentId: string, cursor?: string) => {
      const all = [...pages.entries()].filter(([, p]) => p.parentId === parentId).map(([id]) => id);
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + childPageSize);
      const nextIndex = start + childPageSize;
      return {
        results: slice.map((id) => ({ id, title: pages.get(id)!.title })),
        ...(nextIndex < all.length ? { nextCursor: String(nextIndex) } : {}),
      };
    },
    getPageLabels: async (pageId: string) => pages.get(pageId)?.labels ?? [],
    createPageWithLabel: async (p) => {
      const titleTaken = [...pages.values()].some((pg) => pg.title === p.title);
      if (titleTaken) throw new ApiError("A page with this title already exists", 400, "Bad Request", {});
      const id = String(nextId++);
      pages.set(id, { parentId: p.parentId, title: p.title, body: p.body, labels: [p.label] });
      return { id, title: p.title, url: pageUrl(id) };
    },
  commentOnPage: async () => ({ ok: true }),
  getPageComments: async () => ({ results: [] }),
  searchProjects: async () => ({ values: [] }),
  getMyself: async () => ({ accountId: "test-account" }),
  setProjectProperty: async () => ({ ok: true }),
  getPageVersions: async () => ({}),
  getIssueComments: async () => ({ results: [] }),
  getProjectPropertyOrNull: async () => null,
  };

  /**
   * Directly wires an issue's remote link to a page with an arbitrary
   * id/title/body/version, bypassing `ensureDoc`'s creation path entirely —
   * for `get_doc`-only tests (BUTCHR-270's range-read arms) that need
   * control over the stored body's exact content (e.g. empty, or built for
   * a specific character/byte length) rather than whatever `ensureDoc`
   * would provision.
   */
  function seedIssueDoc(key: string, id: string, title: string, body: string, version = 1) {
    pages.set(id, { parentId: "", title, body, labels: [], version });
    const issue = issues.get(key);
    if (!issue) throw new Error(`fake world: no such issue ${key} — call addIssue first`);
    issue.remoteLink = { title, url: pageUrl(id) };
  }

  return { ops, issues, pages, projectProperties, addIssue, setProjectProperty, seedIssueDoc, upsertCalls: () => upsertRemoteLinkCalls };
}

const ROOT_DOC_ID = "1";
const BUTCHR_PROPERTY = { space: { key: "BUTCHR" }, rootDoc: { id: ROOT_DOC_ID } };

describe("docs.ts: get_doc — never creates, self or other", () => {
  test("no doc on the caller's own ticket -> { found: false }, and creates nothing", async () => {
    const { ops, addIssue, pages } = makeWorld();
    addIssue("BUTCHR-1", "own ticket, no doc yet");
    const result = await getDoc(ops, "BUTCHR-1");
    expect(result).toEqual({ found: false });
    expect(pages.size).toBe(0);
  });

  test("no doc on ANOTHER ticket -> { found: false }, and creates nothing (not even the caller's own logic runs)", async () => {
    const { ops, pages } = makeWorld();
    // Note: this issue isn't even registered in the fake world — get_doc only
    // ever reads the remote link, so it never needs to call getIssue at all.
    const result = await getDoc(ops, "OTHER-999");
    expect(result).toEqual({ found: false });
    expect(pages.size).toBe(0);
  });

  test("a ticket with a doc returns its body/id/url — fits entirely (complete: true)", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-2", "already has a doc");
    const created = await ensureDoc(ops, "BUTCHR-2");
    const result = await getDoc(ops, "BUTCHR-2");
    expect(result).toEqual({
      found: true,
      complete: true,
      id: created.id,
      url: created.url,
      title: created.title,
      version: 1,
      size: { chars: created.body.length, bytes: Buffer.byteLength(created.body, "utf8") },
      body: created.body,
    });
    expect(pages.size).toBe(1);
  });

  test("refuses a malformed key without touching any op", async () => {
    const { ops } = makeWorld();
    await expect(getDoc(ops, "not-a-key")).rejects.toThrow(/not a valid Jira key/);
  });

  test("empty body -> complete: true, body: \"\", size.chars === 0 — distinct from not-found", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    addIssue("BUTCHR-3", "empty doc");
    seedIssueDoc("BUTCHR-3", "900", "empty doc", "");
    const result = await getDoc(ops, "BUTCHR-3");
    expect(result).toEqual({
      found: true,
      complete: true,
      id: "900",
      url: expect.any(String),
      title: "empty doc",
      version: 1,
      size: { chars: 0, bytes: 0 },
      body: "",
    });
    expect(result).not.toEqual({ found: false });
  });

  test("does-not-fit: complete: false, body ABSENT, chunk/slice/next correct", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    const body = "0123456789"; // 10 chars
    addIssue("BUTCHR-4", "oversized (relative to a tiny limit)");
    seedIssueDoc("BUTCHR-4", "901", "oversized", body, 7);
    const result = await getDoc(ops, "BUTCHR-4", 0, 4);
    expect(result).toMatchObject({
      found: true,
      complete: false,
      id: "901",
      version: 7,
      size: { chars: 10, bytes: 10 },
      slice: { offset: 0, chars: 4, bytes: 4 },
      next: { offset: 4 },
      chunk: "0123",
      warning: expect.any(String),
    });
    expect("body" in result).toBe(false); // THE safety rule, asserted explicitly
  });

  test("round trip: paging from 0 via next.offset only reconstructs the body EXACTLY, chars/bytes diverge (em dashes)", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    const body = "a—b—c—d—e—f—g—h—i—j"; // em dashes are 3 UTF-8 bytes each, 1 UTF-16 code unit each
    addIssue("BUTCHR-5", "em-dash body");
    seedIssueDoc("BUTCHR-5", "902", "em-dash body", body);
    expect(body.length).not.toBe(Buffer.byteLength(body, "utf8")); // sanity: chars/bytes really do diverge

    let offset = 0;
    let reconstructed = "";
    let calls = 0;
    for (;;) {
      const result = await getDoc(ops, "BUTCHR-5", offset, 5);
      calls++;
      if (result.found && result.complete) {
        reconstructed += result.body;
        break;
      }
      if (!result.found || result.complete) throw new Error("expected a partial result");
      reconstructed += result.chunk;
      if (!result.next) break; // last slice: complete stays false, but next is absent
      offset = result.next.offset;
      if (calls > 20) throw new Error("pagination did not terminate");
    }
    expect(reconstructed).toBe(body); // THE invariant
  });

  test("astral characters: a surrogate pair straddling the requested boundary is never split; round trip still exact", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    // U+1F600 (😀) is a surrogate pair (2 UTF-16 code units, 4 UTF-8 bytes) placed so a
    // limit of 3 would otherwise cut exactly between its high and low surrogate.
    const body = "ab\u{1F600}cd"; // a b [hi][lo] c d — length 6 in UTF-16 code units
    addIssue("BUTCHR-6", "astral body");
    seedIssueDoc("BUTCHR-6", "903", "astral body", body);

    const first = await getDoc(ops, "BUTCHR-6", 0, 3);
    expect(first.found && !first.complete).toBe(true);
    if (!first.found || first.complete) throw new Error("unreachable");
    // A limit of 3 lands mid-pair (index 2 is the high surrogate, index 3 the
    // low one) — nudged BACKWARD to 2 chars ("ab") rather than splitting it,
    // since shrinking doesn't produce an empty slice here.
    expect(first.chunk).toBe("ab");
    expect(first.slice.chars).toBe(2); // actual length, not the requested limit of 3
    expect("body" in first).toBe(false);
    expect(first.next).toBeDefined();

    let offset = first.next!.offset;
    let reconstructed = first.chunk;
    for (;;) {
      const result = await getDoc(ops, "BUTCHR-6", offset, 3);
      if (result.found && result.complete) {
        reconstructed += result.body;
        break;
      }
      if (!result.found || result.complete) throw new Error("expected a partial result");
      reconstructed += result.chunk;
      if (!result.next) break;
      offset = result.next.offset;
    }
    expect(reconstructed).toBe(body);

    // The OTHER nudge direction: a limit of 1 starting exactly AT the high
    // surrogate (offset 2) would shrink to a zero-length slice — nudged
    // FORWARD past the whole pair instead, so pagination can never stall.
    const atPairStart = await getDoc(ops, "BUTCHR-6", 2, 1);
    if (!atPairStart.found || atPairStart.complete) throw new Error("expected a partial result");
    expect(atPairStart.chunk).toBe("\u{1F600}");
    expect(atPairStart.slice.chars).toBe(2); // actual length, not the requested limit of 1
  });

  test("explicit limit honoured verbatim, including a limit larger than the document (=> complete: true)", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    const body = "0123456789";
    addIssue("BUTCHR-7", "small doc, huge limit");
    seedIssueDoc("BUTCHR-7", "904", "small doc", body);
    const result = await getDoc(ops, "BUTCHR-7", 0, 1_000_000);
    expect(result).toMatchObject({ found: true, complete: true, body });

    const partial = await getDoc(ops, "BUTCHR-7", 0, 3);
    expect(partial).toMatchObject({ complete: false, slice: { chars: 3 } });
  });

  test("offset exactly at the end -> empty chunk, next absent", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    const body = "0123456789";
    addIssue("BUTCHR-8", "offset at end");
    seedIssueDoc("BUTCHR-8", "905", "offset at end", body);
    const result = await getDoc(ops, "BUTCHR-8", 10, 5);
    expect(result).toMatchObject({ found: true, complete: false, slice: { offset: 10, chars: 0 }, chunk: "" });
    if (!result.found || result.complete) throw new Error("unreachable");
    expect(result.next).toBeUndefined();
    expect("body" in result).toBe(false);
  });

  describe("refusals", () => {
    test("offset past the end names the real size", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-9", "short doc");
      seedIssueDoc("BUTCHR-9", "906", "short doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-9", 11)).rejects.toThrow(/10 characters/);
    });
    test("negative offset refuses", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-10", "doc");
      seedIssueDoc("BUTCHR-10", "907", "doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-10", -1)).rejects.toThrow(/non-negative integer/);
    });
    test("non-integer offset refuses", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-11", "doc");
      seedIssueDoc("BUTCHR-11", "908", "doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-11", 1.5)).rejects.toThrow(/non-negative integer/);
    });
    test("limit < 1 refuses", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-120", "doc");
      seedIssueDoc("BUTCHR-120", "909", "doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-120", 0, 0)).rejects.toThrow(/positive integer/);
      await expect(getDoc(ops, "BUTCHR-120", 0, -5)).rejects.toThrow(/positive integer/);
    });
    test("non-integer limit refuses", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-130", "doc");
      seedIssueDoc("BUTCHR-130", "910", "doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-130", 0, 2.5)).rejects.toThrow(/positive integer/);
    });
  });
});

describe("docs.ts: ensureDoc — lazy nested creation", () => {
  test("bottoms out at the project root doc when the ticket has no boss", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-25", "epic with no boss");
    const doc = await ensureDoc(ops, "BUTCHR-25");
    expect(pages.get(doc.id)?.parentId).toBe(ROOT_DOC_ID);
    expect(pages.get(doc.id)?.labels).toEqual([labelForKey("BUTCHR-25")]);
    expect(doc.title).toBe("[unwritten] BUTCHR-25 — epic with no boss");
  });

  test("the full lazy boss chain: task -> story -> epic -> root, each nested under the last, each linked and labelled", async () => {
    const { ops, addIssue, pages, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-25", "epic, no boss");
    addIssue("BUTCHR-27", "story", "BUTCHR-25");
    addIssue("BUTCHR-33", "task", "BUTCHR-27");

    const taskDoc = await ensureDoc(ops, "BUTCHR-33");
    expect(pages.size).toBe(3); // task + story + epic, none extra

    const storyPageId = pages.get(taskDoc.id)!.parentId;
    const storyDoc = pages.get(storyPageId)!;
    expect(storyDoc.labels).toEqual([labelForKey("BUTCHR-27")]);

    const epicPageId = storyDoc.parentId;
    const epicDoc = pages.get(epicPageId)!;
    expect(epicDoc.labels).toEqual([labelForKey("BUTCHR-25")]);
    expect(epicDoc.parentId).toBe(ROOT_DOC_ID); // bottoms out correctly

    // both directions of the binding, for every ticket in the chain
    for (const key of ["BUTCHR-33", "BUTCHR-27", "BUTCHR-25"]) {
      expect(issues.get(key)?.remoteLink?.url).toBeTruthy();
    }
  });

  test("a re-run is a no-op: same page, same link, nothing duplicated (the idempotent-upsert path)", async () => {
    const { ops, addIssue, pages, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-40", "idempotency check");
    const first = await ensureDoc(ops, "BUTCHR-40");
    const linkAfterFirst = issues.get("BUTCHR-40")!.remoteLink;
    const second = await ensureDoc(ops, "BUTCHR-40");
    expect(second.id).toBe(first.id);
    expect(pages.size).toBe(1);
    expect(issues.get("BUTCHR-40")!.remoteLink).toEqual(linkAfterFirst);
  });

  test("fail-at-5 recovery: a page already exists and is labelled, but the ticket's remote link was never written — adopts it, makes NO second page", async () => {
    const { ops, addIssue, pages, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-41", "orphaned page, no link yet");
    // Simulate the fail-at-5 partial state directly: the page exists and is
    // labelled, but nothing ever ran step 5 to link it back.
    pages.set("500", { parentId: ROOT_DOC_ID, title: "[unwritten] BUTCHR-41 — orphaned page, no link yet", body: "<p/>", labels: [labelForKey("BUTCHR-41")] });
    expect(issues.get("BUTCHR-41")!.remoteLink).toBeUndefined();

    const doc = await ensureDoc(ops, "BUTCHR-41");
    expect(doc.id).toBe("500");
    expect(pages.size).toBe(1); // no second page created
    expect(issues.get("BUTCHR-41")!.remoteLink?.url).toContain("/pages/500");
  });

  test("exhaustive pagination: a labelled page past the first page of children is still found (not a false 'no doc')", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld({ childPageSize: 1 });
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    // Three unrelated siblings already under the root doc before the target's label...
    pages.set("601", { parentId: ROOT_DOC_ID, title: "sibling one", body: "", labels: [] });
    pages.set("602", { parentId: ROOT_DOC_ID, title: "sibling two", body: "", labels: [] });
    pages.set("603", { parentId: ROOT_DOC_ID, title: "[unwritten] BUTCHR-42 — target, three pages in", body: "", labels: [labelForKey("BUTCHR-42")] });
    addIssue("BUTCHR-42", "target, three pages in");

    const doc = await ensureDoc(ops, "BUTCHR-42");
    expect(doc.id).toBe("603"); // adopted the existing page...
    expect(pages.size).toBe(3); // ...instead of creating a 4th
  });

  test("race guard: a title collision (400) on create triggers exactly one re-scan, adopting the winner instead of failing or looping", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-43", "raced by a concurrent caller");

    // Step 3's initial scan must find NOTHING (that's the whole point of a
    // race), so the "concurrent winner" page is inserted from INSIDE
    // createPageWithLabel itself — i.e. exactly between our own step-3 scan
    // and our own step-4 create, which is when a real race would land it.
    let raced = false;
    const racedOps: AtlassianOps = {
      ...ops,
      createPageWithLabel: async (p) => {
        if (!raced) {
          raced = true;
          pages.set("700", { parentId: p.parentId, title: p.title, body: p.body, labels: [p.label] });
        }
        throw new ApiError("A page with this title already exists", 400, "Bad Request", {});
      },
    };

    const doc = await ensureDoc(racedOps, "BUTCHR-43");
    expect(doc.id).toBe("700");
    expect(pages.size).toBe(1); // never created a second page after the 400
  });

  test("a non-collision error from createPageWithLabel is NOT swallowed as a race", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-44", "genuine failure, not a race");
    const failingOps: AtlassianOps = { ...ops, createPageWithLabel: async () => { throw new ApiError("nope", 500, "Server Error", {}); } };
    await expect(ensureDoc(failingOps, "BUTCHR-44")).rejects.toThrow(/nope/);
  });

  test("refuses when the project entity property is missing, naming the property and project", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("KAN-1", "no butchr property configured for this project");
    await expect(ensureDoc(ops, "KAN-1")).rejects.toThrow(/butchr.*KAN/s);
  });

  test("refuses on a malformed key rather than emitting an uninvertible label", async () => {
    const { ops } = makeWorld();
    await expect(ensureDoc(ops, "not-a-key")).rejects.toThrow(/not a valid Jira key/);
  });

  test("cycle guard: an Implements cycle refuses instead of recursing forever", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-50", "cycle a", "BUTCHR-51");
    addIssue("BUTCHR-51", "cycle b", "BUTCHR-50");
    await expect(ensureDoc(ops, "BUTCHR-50")).rejects.toThrow(/boss chain/);
  });
});

describe("docs.ts: set_doc — full replace, provisional-title refusal", () => {
  test("while the title is still provisional, set_doc REQUIRES a title", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-60", "still provisional");
    await expect(setDoc(ops, "BUTCHR-60", "<p>real content</p>")).rejects.toThrow(/provisional/);
  });

  test("supplying a title while provisional succeeds and replaces the body and title", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-61", "about to be titled");
    const result = await setDoc(ops, "BUTCHR-61", "<p>real content</p>", "A real outcome-shaped title");
    expect(result.title).toBe("A real outcome-shaped title");
    expect(pages.get(result.id)?.title).toBe("A real outcome-shaped title");
    expect(pages.get(result.id)?.body).toBe("<p>real content</p>");
  });

  test("once titled, omitting `title` keeps the current title (no longer required)", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-62", "already titled");
    const first = await setDoc(ops, "BUTCHR-62", "<p>v1</p>", "Outcome title");
    const second = await setDoc(ops, "BUTCHR-62", "<p>v2</p>");
    expect(second.title).toBe("Outcome title");
    expect(pages.get(first.id)?.body).toBe("<p>v2</p>");
  });

  test("is a FULL replace, not an append — the old body is gone", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-63", "replace check");
    const first = await setDoc(ops, "BUTCHR-63", "<p>first</p>", "T");
    await setDoc(ops, "BUTCHR-63", "<p>second only</p>");
    expect(pages.get(first.id)?.body).toBe("<p>second only</p>");
  });

  test("ensures the doc exists first (creates it lazily) when the ticket had none", async () => {
    const { ops, addIssue, pages, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-64", "brand new");
    expect(issues.get("BUTCHR-64")!.remoteLink).toBeUndefined();
    await setDoc(ops, "BUTCHR-64", "<p>x</p>", "T");
    expect(pages.size).toBe(1);
    expect(issues.get("BUTCHR-64")!.remoteLink).toBeTruthy();
  });

  // PR #112 review: retitling via set_doc must refresh the remote link's own
  // title too, not just the page's — the link is what a human actually sees
  // on the Jira ticket, and it was upserted once already (by ensureDoc, on
  // first write) carrying whatever title the page had at THAT moment.
  test("retitling via set_doc refreshes the remote link's title, not just the page's", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-65", "link must not go stale");
    // Lazily create the doc first (ensureDoc's own step-5 upsert carries
    // whatever title the page has AT THAT MOMENT — the provisional one).
    await ensureDoc(ops, "BUTCHR-65");
    expect(issues.get("BUTCHR-65")!.remoteLink!.title).toBe("[unwritten] BUTCHR-65 — link must not go stale");
    // Retitling write: the link must now read the REAL title, not the stale provisional one.
    const result = await setDoc(ops, "BUTCHR-65", "<p>real content</p>", "A real outcome-shaped title");
    expect(result.title).toBe("A real outcome-shaped title");
    expect(issues.get("BUTCHR-65")!.remoteLink!.title).toBe("A real outcome-shaped title");
  });

  test("a body-only write (title omitted) does NOT re-upsert the link — no title changed, nothing to refresh", async () => {
    const { ops, addIssue, upsertCalls, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-66", "no spurious link writes");
    await setDoc(ops, "BUTCHR-66", "<p>v1</p>", "Outcome title"); // ensureDoc's upsert (1) + this retitle's refresh (2)
    const callsAfterFirstWrite = upsertCalls();
    await setDoc(ops, "BUTCHR-66", "<p>v2</p>"); // body-only — title unchanged
    expect(upsertCalls()).toBe(callsAfterFirstWrite); // no additional upsert
  });
});

describe("docs.ts: the provisional body's ASSIST pointer", () => {
  // BUTCHR-25 (operator, late addition): the assistant documents this estate in a
  // Confluence space nothing routed an agent to. The provisional body is the ONLY
  // text the tool itself authors and the one thing a newly-born agent is certain
  // to read, so it carries the pointer. These tests exist so the pointer cannot be
  // dropped silently by someone tidying the body text — the reason it is here is
  // not visible from the string itself.
  test("a freshly created doc points at the ASSIST space and its entry points", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-70", "a newborn agent reads this once");
    const doc = await ensureDoc(ops, "BUTCHR-70");
    const body = pages.get(doc.id)!.body;
    expect(body).toContain("/wiki/spaces/ASSIST/overview");
    expect(body).toContain("/wiki/spaces/ASSIST/pages/12714016"); // the factory, end to end
    expect(body).toContain("/wiki/spaces/ASSIST/pages/12386388"); // working agreements with agents
    // still carries the ticket affordance it always did
    expect(body).toContain("BUTCHR-70");
  });

  test("the pointer is transient by design — the first set_doc replaces it", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-71", "pointer is scaffolding, not content");
    const doc = await ensureDoc(ops, "BUTCHR-71");
    expect(pages.get(doc.id)!.body).toContain("ASSIST");
    await setDoc(ops, "BUTCHR-71", "<p>what actually happened</p>", "A real outcome title");
    // Replaced wholesale, pointer included. That is correct: by now the agent has
    // read it, and the doc's job has changed from orienting its author to recording.
    expect(pages.get(doc.id)!.body).toBe("<p>what actually happened</p>");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-71, Contract 1: a PROJECT's doc resolves to its ROOT DOC — never
// created, never ensureDoc'd. What would make each check below FAIL, stated
// up front: getProjectDoc/setProjectDoc calling ensureDoc (creating a page)
// would fail "never creates a page"; reading the wrong page id would fail
// the round-trip test; a missing property or rootDoc.id NOT throwing would
// fail the refusal tests; set_doc requiring `title` on first write for a
// project would fail the "title stays optional" test (a root doc, unlike a
// fresh per-ticket page, already has a real title from provisioning).
// ---------------------------------------------------------------------------
describe("docs.ts: projectRootDoc / getProjectDoc / setProjectDoc (BUTCHR-71 Contract 1)", () => {
  function seedRootDoc(pages: Map<string, { parentId: string; title: string; body: string; labels: string[] }>, id: string, title: string, body: string) {
    // A project's root doc is provisioned AHEAD OF TIME (BUTCHR-62's doc: six
    // product projects + ASSIST already carry one) — seeded directly here,
    // never via ensureDoc, matching that reality.
    pages.set(id, { parentId: "", title, body, labels: [] });
  }

  test("resolves the project's root doc via the EXISTING entity-property reader — same shape ensureDoc already reads, no second reader", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "77", "BUTCHR — product brief", "<p>the brief</p>");
    setProjectProperty("BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "77" } });
    const doc = await projectRootDoc(ops, "BUTCHR");
    expect(doc.id).toBe("77");
    expect(doc.title).toBe("BUTCHR — product brief");
    expect(doc.body).toBe("<p>the brief</p>");
  });

  test("REFUSES, naming the project, when the butchr entity property is unreadable — never falls back to creating a page", async () => {
    const { ops, pages } = makeWorld(); // no setProjectProperty call at all
    await expect(projectRootDoc(ops, "BUTCHR")).rejects.toThrow(/BUTCHR.*unreadable/s);
    expect(pages.size).toBe(0); // nothing was created
  });

  test("REFUSES, naming the project, when rootDoc.id is missing from an otherwise-readable property", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", { space: { key: "BUTCHR" } }); // no rootDoc at all
    await expect(projectRootDoc(ops, "BUTCHR")).rejects.toThrow(/BUTCHR.*rootDoc\.id/s);
    expect(pages.size).toBe(0);
  });

  test("getProjectDoc never creates a page, unlike get_doc's own ensureDoc-backed sibling for an issue with no doc yet — fits entirely (complete: true)", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "5", "CATA — product brief", "<p>hi</p>");
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "5" } });
    const before = pages.size;
    const result = await getProjectDoc(ops, "CATA");
    expect(result).toEqual({
      found: true,
      complete: true,
      id: "5",
      url: expect.any(String),
      title: "CATA — product brief",
      version: 1,
      size: { chars: "<p>hi</p>".length, bytes: Buffer.byteLength("<p>hi</p>", "utf8") },
      body: "<p>hi</p>",
    });
    expect(pages.size).toBe(before); // no page was created
  });

  test("setProjectDoc is a full-body replace of the root doc, NEVER calling ensureDoc — no create/nest/label path for a project caller", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "9", "SCHEM — product brief", "<p>stale</p>");
    setProjectProperty("SCHEM", { space: { key: "SCHEM" }, rootDoc: { id: "9" } });
    const before = pages.size;
    const result = await setProjectDoc(ops, "SCHEM", "<p>current</p>");
    expect(pages.get("9")!.body).toBe("<p>current</p>");
    expect(pages.size).toBe(before); // still no new page
    expect(result.title).toBe("SCHEM — product brief"); // title unchanged, since none was passed
  });

  test("title stays OPTIONAL on a project's very first set_doc call — unlike an issue's provisional-title gate, a root doc already has a real title", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "3", "RINTH — product brief", "<p>anything</p>");
    setProjectProperty("RINTH", { space: { key: "RINTH" }, rootDoc: { id: "3" } });
    // No title passed, and this must NOT throw the way set_doc would for an
    // issue whose doc still carries "[unwritten]".
    await expect(setProjectDoc(ops, "RINTH", "<p>new body, no title</p>")).resolves.toBeDefined();
    expect(pages.get("3")!.title).toBe("RINTH — product brief"); // unchanged
  });

  test("setProjectDoc CAN retitle when a title is passed", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "4", "old title", "<p>x</p>");
    setProjectProperty("KAN", { space: { key: "KAN" }, rootDoc: { id: "4" } });
    const result = await setProjectDoc(ops, "KAN", "<p>x</p>", "new title");
    expect(result.title).toBe("new title");
    expect(pages.get("4")!.title).toBe("new title");
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-270: get_doc's bounded range read, PROJECT dispatch branch
// (getProjectDoc). The root doc is the largest document on this surface and
// the whole reason this work exists, so every arm the issue branch above is
// tested for gets its own mirror here rather than being assumed to transfer.
// ---------------------------------------------------------------------------
describe("docs.ts: get_doc bounded range reads — project root doc branch (BUTCHR-270)", () => {
  function seedRootDoc(pages: Map<string, { parentId: string; title: string; body: string; labels: string[]; version?: number }>, id: string, title: string, body: string) {
    pages.set(id, { parentId: "", title, body, labels: [] });
  }

  test("empty body -> complete: true, body: \"\", size.chars === 0 — distinct from not-found", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedRootDoc(pages, "950", "CATA — product brief", "");
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "950" } });
    const result = await getProjectDoc(ops, "CATA");
    expect(result).toEqual({
      found: true,
      complete: true,
      id: "950",
      url: expect.any(String),
      title: "CATA — product brief",
      version: 1,
      size: { chars: 0, bytes: 0 },
      body: "",
    });
  });

  test("does-not-fit: complete: false, body ABSENT, chunk/slice/next correct", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const body = "0123456789";
    seedRootDoc(pages, "951", "oversized root doc", body);
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "951" } });
    const result = await getProjectDoc(ops, "CATA", 0, 4);
    expect(result).toMatchObject({
      found: true,
      complete: false,
      id: "951",
      size: { chars: 10, bytes: 10 },
      slice: { offset: 0, chars: 4, bytes: 4 },
      next: { offset: 4 },
      chunk: "0123",
      warning: expect.any(String),
    });
    expect("body" in result).toBe(false);
  });

  test("round trip: paging from 0 via next.offset only reconstructs the root doc body EXACTLY, chars/bytes diverge (em dashes)", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const body = "a—b—c—d—e—f—g—h—i—j";
    seedRootDoc(pages, "952", "root doc", body);
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "952" } });

    let offset = 0;
    let reconstructed = "";
    let calls = 0;
    for (;;) {
      const result = await getProjectDoc(ops, "CATA", offset, 5);
      calls++;
      if (result.found && result.complete) {
        reconstructed += result.body;
        break;
      }
      if (!result.found || result.complete) throw new Error("expected a partial result");
      reconstructed += result.chunk;
      if (!result.next) break;
      offset = result.next.offset;
      if (calls > 20) throw new Error("pagination did not terminate");
    }
    expect(reconstructed).toBe(body);
  });

  test("astral characters: a surrogate pair straddling the requested boundary is never split; round trip still exact", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const body = "ab\u{1F600}cd";
    seedRootDoc(pages, "953", "root doc", body);
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "953" } });

    const first = await getProjectDoc(ops, "CATA", 0, 3);
    expect(first.found && !first.complete).toBe(true);
    if (!first.found || first.complete) throw new Error("unreachable");
    // Nudged BACKWARD to 2 chars ("ab") rather than splitting the pair.
    expect(first.chunk).toBe("ab");
    expect(first.slice.chars).toBe(2);
    expect("body" in first).toBe(false);

    let offset = first.next!.offset;
    let reconstructed = first.chunk;
    for (;;) {
      const result = await getProjectDoc(ops, "CATA", offset, 3);
      if (result.found && result.complete) {
        reconstructed += result.body;
        break;
      }
      if (!result.found || result.complete) throw new Error("expected a partial result");
      reconstructed += result.chunk;
      if (!result.next) break;
      offset = result.next.offset;
    }
    expect(reconstructed).toBe(body);

    // The OTHER nudge direction: a limit of 1 starting exactly AT the high
    // surrogate would shrink to a zero-length slice — nudged FORWARD past
    // the whole pair instead.
    const atPairStart = await getProjectDoc(ops, "CATA", 2, 1);
    if (!atPairStart.found || atPairStart.complete) throw new Error("expected a partial result");
    expect(atPairStart.chunk).toBe("\u{1F600}");
    expect(atPairStart.slice.chars).toBe(2);
  });

  test("explicit limit honoured verbatim, including a limit larger than the document (=> complete: true)", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const body = "0123456789";
    seedRootDoc(pages, "954", "root doc", body);
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "954" } });
    const result = await getProjectDoc(ops, "CATA", 0, 1_000_000);
    expect(result).toMatchObject({ found: true, complete: true, body });

    const partial = await getProjectDoc(ops, "CATA", 0, 3);
    expect(partial).toMatchObject({ complete: false, slice: { chars: 3 } });
  });

  test("offset exactly at the end -> empty chunk, next absent", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const body = "0123456789";
    seedRootDoc(pages, "955", "root doc", body);
    setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "955" } });
    const result = await getProjectDoc(ops, "CATA", 10, 5);
    expect(result).toMatchObject({ found: true, complete: false, slice: { offset: 10, chars: 0 }, chunk: "" });
    if (!result.found || result.complete) throw new Error("unreachable");
    expect(result.next).toBeUndefined();
    expect("body" in result).toBe(false);
  });

  describe("refusals", () => {
    test("offset past the end names the real size", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "956", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "956" } });
      await expect(getProjectDoc(ops, "CATA", 11)).rejects.toThrow(/10 characters/);
    });
    test("negative offset refuses", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "957", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "957" } });
      await expect(getProjectDoc(ops, "CATA", -1)).rejects.toThrow(/non-negative integer/);
    });
    test("non-integer offset refuses", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "958", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "958" } });
      await expect(getProjectDoc(ops, "CATA", 1.5)).rejects.toThrow(/non-negative integer/);
    });
    test("limit < 1 refuses", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "959", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "959" } });
      await expect(getProjectDoc(ops, "CATA", 0, 0)).rejects.toThrow(/positive integer/);
    });
    test("non-integer limit refuses", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "960", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "960" } });
      await expect(getProjectDoc(ops, "CATA", 0, 2.5)).rejects.toThrow(/positive integer/);
    });
  });
});

describe("docs.ts: labelForKey / JIRA_KEY_RE", () => {
  test("round-trips a valid key losslessly (lowercased)", () => {
    expect(labelForKey("BUTCHR-27")).toBe("butchr-ticket-butchr-27");
    expect(labelForKey("BUTCHR_TEAM-9")).toBe("butchr-ticket-butchr_team-9");
  });
  test("refuses a key shape it can't invert back from", () => {
    expect(() => labelForKey("not-a-key")).toThrow(/not a valid Jira key/);
    expect(() => labelForKey("lowercase-1")).toThrow();
    expect(JIRA_KEY_RE.test("BUTCHR-27")).toBe(true);
    expect(JIRA_KEY_RE.test("butchr-27")).toBe(false);
  });
});
