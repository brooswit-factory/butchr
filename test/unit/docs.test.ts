import { describe, expect, test } from "bun:test";
import { ApiError } from "confluence.js/core";
import { getDoc, setDoc, findDoc, labelForKey, JIRA_KEY_RE, projectRootDoc, getProjectDoc, setProjectDoc, DOC_BODY_CHAR_BUDGET } from "../../src/tools/docs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/**
 * A small stateful Jira+Confluence world implementing the full `AtlassianOps`
 * surface, used only by this file. docs.ts's logic is genuinely stateful
 * across calls in a way the simple call-recording `rig()` in tools.test.ts
 * isn't built for — this fake exists for that reason, not as a second
 * version of that one. Everything docs.ts doesn't touch (search, addComment,
 * …) is stubbed since it's never called. `createPageWithLabel`/
 * `getChildPages`/`getPageLabels` remain on this fake even though nothing in
 * docs.ts calls them anymore post-FACTORY-86 (they backed `ensureDoc`'s
 * retired creation path) — kept only because they're still part of the
 * `AtlassianOps` interface every fake must implement in full.
 */
function makeWorld(opts: { childPageSize?: number } = {}) {
  const childPageSize = opts.childPageSize ?? 50;
  const issues = new Map<string, { summary: string; bossKey?: string; remoteLink?: { title: string; url: string } }>();
  const pages = new Map<string, { parentId: string; title: string; body: string; labels: string[]; version: number }>();
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
      return { title: p.title, body: { storage: { value: p.body } }, version: { number: p.version }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } };
    },
    updatePage: async (p) => {
      const page = pages.get(p.id);
      if (!page) throw new Error(`fake world: no such page ${p.id}`);
      page.body = p.body;
      if (p.title) page.title = p.title;
      page.version++;
      return { ok: true, version: page.version };
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
      pages.set(id, { parentId: p.parentId, title: p.title, body: p.body, labels: [p.label], version: 1 });
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
   * id/title/body/version — the ONLY way to give a test issue a doc now
   * that nothing in docs.ts ever creates one (FACTORY-84/FACTORY-86). Used
   * both by `get_doc`-only tests (BUTCHR-270's range-read arms) that need
   * control over the stored body's exact content, and by any `set_doc` test
   * that needs a pre-existing doc to write into.
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
    const { ops, addIssue, pages, seedIssueDoc } = makeWorld();
    addIssue("BUTCHR-2", "already has a doc");
    seedIssueDoc("BUTCHR-2", "800", "an existing doc", "<p>hello</p>");
    const result = await getDoc(ops, "BUTCHR-2");
    expect(result).toEqual({
      found: true,
      complete: true,
      id: "800",
      url: expect.any(String),
      title: "an existing doc",
      version: 1,
      size: { chars: "<p>hello</p>".length, bytes: Buffer.byteLength("<p>hello</p>", "utf8") },
      body: "<p>hello</p>",
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
      const result = await getDoc(ops, "BUTCHR-5", offset, 5, offset === 0 ? undefined : 1);
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
      const result = await getDoc(ops, "BUTCHR-6", offset, 3, offset === 0 ? undefined : 1);
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
    const atPairStart = await getDoc(ops, "BUTCHR-6", 2, 1, 1);
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
    const result = await getDoc(ops, "BUTCHR-8", 10, 5, 1);
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
      await expect(getDoc(ops, "BUTCHR-9", 11, undefined, 1)).rejects.toThrow(/10 characters/);
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
      await expect(getDoc(ops, "BUTCHR-120", 0, 0, 1)).rejects.toThrow(/positive integer/);
      await expect(getDoc(ops, "BUTCHR-120", 0, -5)).rejects.toThrow(/positive integer/);
    });
    test("non-integer limit refuses", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-130", "doc");
      seedIssueDoc("BUTCHR-130", "910", "doc", "0123456789");
      await expect(getDoc(ops, "BUTCHR-130", 0, 2.5)).rejects.toThrow(/positive integer/);
    });
  });

  // -------------------------------------------------------------------------
  // BUTCHR-230 review: version drift across a multi-call read. The hazard is
  // the mirror of the one `body`-only-when-`complete` closes — there a caller
  // writes back TOO LITTLE, here it writes back a body that never existed at
  // any point in time. Both end at `set_doc`, a full-body replace. Closed the
  // same way: the bad state is made unreachable, not documented.
  describe("version drift (BUTCHR-230 review)", () => {
    test("THE RULE IS IN THE WARNING ITSELF — a partial tells the caller to pin expectVersion and to discard-and-restart on drift", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-40", "big doc");
      seedIssueDoc("BUTCHR-40", "940", "big doc", "x".repeat(100));
      const r: any = await getDoc(ops, "BUTCHR-40", 0, 10);
      expect(r.complete).toBe(false);
      // Would fail if a later edit drops the rule from the warning text — which
      // is the whole reason this asserts on prose rather than trusting it.
      expect(r.warning).toMatch(/expectVersion/);
      expect(r.warning).toMatch(/REQUIRED on every call with offset > 0/);
      expect(r.warning).toMatch(/NEVER concatenate chunks that came from different versions/);
      expect(r.warning).toMatch(/DISCARD every chunk/i);
      expect(r.warning).toMatch(/restart from offset 0/i);
    });

    test("expectVersion is REQUIRED once offset > 0 — the splice is unrepresentable, not merely discouraged", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-41", "big doc");
      seedIssueDoc("BUTCHR-41", "941", "big doc", "x".repeat(100));
      await expect(getDoc(ops, "BUTCHR-41", 10, 10)).rejects.toThrow(/expectVersion is required when offset > 0/);
      // offset 0 still needs nothing: a first slice has no earlier version to agree with.
      await expect(getDoc(ops, "BUTCHR-41", 0, 10)).resolves.toBeDefined();
    });

    test("a page edited mid-read REFUSES the continuation instead of splicing two versions", async () => {
      const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
      addIssue("BUTCHR-42", "edited doc");
      seedIssueDoc("BUTCHR-42", "942", "edited doc", "x".repeat(100), 3);
      const first: any = await getDoc(ops, "BUTCHR-42", 0, 10);
      expect(first.version).toBe(3);
      // somebody writes the page between slice 1 and slice 2
      pages.set("942", { ...pages.get("942")!, body: "y".repeat(100), version: 4 });
      await expect(getDoc(ops, "BUTCHR-42", first.next.offset, 10, first.version)).rejects.toThrow(/changed mid-read/);
      await expect(getDoc(ops, "BUTCHR-42", first.next.offset, 10, first.version)).rejects.toThrow(/restart from offset 0/);
    });

    test("an UNVERIFIABLE pin refuses too — a version that could not be read is not a satisfied pin", async () => {
      const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
      addIssue("BUTCHR-43", "versionless doc");
      seedIssueDoc("BUTCHR-43", "943", "versionless doc", "x".repeat(100));
      pages.set("943", { ...pages.get("943")!, version: undefined as any });
      await expect(getDoc(ops, "BUTCHR-43", 10, 10, 1)).rejects.toThrow(/unverifiable/);
    });

    test("a matching pin reads through, and the full paginated round trip still reconstructs exactly", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      const body = "a—b—c—d—e—f—g—h—i—j";
      addIssue("BUTCHR-44", "pinned doc");
      seedIssueDoc("BUTCHR-44", "944", "pinned doc", body, 9);
      const first: any = await getDoc(ops, "BUTCHR-44", 0, 5);
      expect(first.version).toBe(9);
      let offset = first.next.offset, out = first.chunk, guard = 0;
      for (;;) {
        const r: any = await getDoc(ops, "BUTCHR-44", offset, 5, first.version);
        out += r.chunk;
        if (!r.next) break;
        offset = r.next.offset;
        if (++guard > 20) throw new Error("pagination did not terminate");
      }
      expect(out).toBe(body);
    });

    test("expectVersion shape is validated: non-integer and non-positive refuse", async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-45", "doc");
      seedIssueDoc("BUTCHR-45", "945", "doc", "x".repeat(100));
      await expect(getDoc(ops, "BUTCHR-45", 10, 10, 2.5)).rejects.toThrow(/expectVersion must be a positive integer/);
      await expect(getDoc(ops, "BUTCHR-45", 10, 10, 0)).rejects.toThrow(/expectVersion must be a positive integer/);
    });
  });

});

describe("docs.ts: findDoc — never creates, links, or infers a space/parent (FACTORY-84/FACTORY-86)", () => {
  test("a ticket with no doc -> null, and touches no write op at all", async () => {
    const { ops, addIssue, pages, issues, upsertCalls } = makeWorld();
    addIssue("BUTCHR-25", "never asked for a doc");
    const doc = await findDoc(ops, "BUTCHR-25");
    expect(doc).toBeNull();
    expect(pages.size).toBe(0); // no page created
    expect(issues.get("BUTCHR-25")!.remoteLink).toBeUndefined(); // no link written
    expect(upsertCalls()).toBe(0);
  });

  test("a ticket that never asked for a doc STAYS that way across repeated calls — no page ever appears", async () => {
    const { ops, addIssue, pages } = makeWorld();
    addIssue("BUTCHR-40", "repeated reads");
    await findDoc(ops, "BUTCHR-40");
    await findDoc(ops, "BUTCHR-40");
    const doc = await findDoc(ops, "BUTCHR-40");
    expect(doc).toBeNull();
    expect(pages.size).toBe(0);
  });

  test("an existing (pre-existing, or manually linked) doc is returned as-is — reads are unaffected by this change", async () => {
    const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
    addIssue("BUTCHR-41", "already has a doc from before this change");
    seedIssueDoc("BUTCHR-41", "500", "[unwritten] BUTCHR-41 — orphaned page, no link yet", "<p/>");
    const doc = await findDoc(ops, "BUTCHR-41");
    expect(doc?.id).toBe("500");
    expect(pages.size).toBe(1); // nothing extra created
  });

  test("a bossless ticket's doc is STILL just 'none' — this function never bottoms out at the project root doc, unlike the retired ensureDoc", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-26", "epic with no boss, no doc");
    const doc = await findDoc(ops, "BUTCHR-26");
    expect(doc).toBeNull();
    expect(pages.size).toBe(0);
  });

  test("refuses on a malformed key rather than trying to read anything", async () => {
    const { ops } = makeWorld();
    await expect(findDoc(ops, "not-a-key")).rejects.toThrow(/not a valid Jira key/);
  });

  test("never calls createPageWithLabel/getChildPages/getPageLabels/upsertRemoteLink — the retired creation machinery is never reached", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-51", "instrumented");
    let createCalled = false;
    let childPagesCalled = false;
    let pageLabelsCalled = false;
    let upsertCalled = false;
    const instrumentedOps: AtlassianOps = {
      ...ops,
      createPageWithLabel: async (p) => { createCalled = true; return ops.createPageWithLabel(p); },
      getChildPages: async (id, cursor) => { childPagesCalled = true; return ops.getChildPages(id, cursor); },
      getPageLabels: async (id) => { pageLabelsCalled = true; return ops.getPageLabels(id); },
      upsertRemoteLink: async (key, globalId, relationship, object) => { upsertCalled = true; return ops.upsertRemoteLink(key, globalId, relationship, object); },
    };
    await findDoc(instrumentedOps, "BUTCHR-51");
    expect(createCalled).toBe(false);
    expect(childPagesCalled).toBe(false);
    expect(pageLabelsCalled).toBe(false);
    expect(upsertCalled).toBe(false);
  });
});

describe("docs.ts: set_doc — never creates; refuses a ticket with no doc (FACTORY-84/FACTORY-86)", () => {
  test("a ticket with NO doc is REFUSED — names the situation, points at the on-request path, and creates nothing", async () => {
    const { ops, addIssue, pages, issues } = makeWorld();
    addIssue("BUTCHR-64", "brand new, never asked for a doc");
    await expect(setDoc(ops, "BUTCHR-64", "<p>x</p>", "T")).rejects.toThrow(/no Confluence doc/);
    await expect(setDoc(ops, "BUTCHR-64", "<p>x</p>", "T")).rejects.toThrow(/confluence_create_page/);
    expect(pages.size).toBe(0); // no page created
    expect(issues.get("BUTCHR-64")!.remoteLink).toBeUndefined(); // no link written
  });

  test("while an EXISTING (pre-change) doc's title is still provisional, set_doc REQUIRES a title", async () => {
    const { ops, addIssue, seedIssueDoc } = makeWorld();
    addIssue("BUTCHR-60", "still provisional, from before this change");
    seedIssueDoc("BUTCHR-60", "800", "[unwritten] BUTCHR-60 — still provisional, from before this change", "<p/>");
    await expect(setDoc(ops, "BUTCHR-60", "<p>real content</p>")).rejects.toThrow(/provisional/);
  });

  test("supplying a title while provisional succeeds and replaces the body and title", async () => {
    const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
    addIssue("BUTCHR-61", "about to be titled");
    seedIssueDoc("BUTCHR-61", "801", "[unwritten] BUTCHR-61 — about to be titled", "<p/>");
    const result = await setDoc(ops, "BUTCHR-61", "<p>real content</p>", "A real outcome-shaped title");
    expect(result.title).toBe("A real outcome-shaped title");
    expect(pages.get(result.id)?.title).toBe("A real outcome-shaped title");
    expect(pages.get(result.id)?.body).toBe("<p>real content</p>");
  });

  test("once titled, omitting `title` keeps the current title (no longer required)", async () => {
    const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
    addIssue("BUTCHR-62", "already titled");
    seedIssueDoc("BUTCHR-62", "802", "Outcome title", "<p>v0</p>");
    const first = await setDoc(ops, "BUTCHR-62", "<p>v1</p>");
    const second = await setDoc(ops, "BUTCHR-62", "<p>v2</p>");
    expect(second.title).toBe("Outcome title");
    expect(pages.get(first.id)?.body).toBe("<p>v2</p>");
  });

  test("is a FULL replace, not an append — the old body is gone", async () => {
    const { ops, addIssue, seedIssueDoc, pages } = makeWorld();
    addIssue("BUTCHR-63", "replace check");
    seedIssueDoc("BUTCHR-63", "803", "T", "<p>first</p>");
    const first = await setDoc(ops, "BUTCHR-63", "<p>second only</p>");
    expect(pages.get(first.id)?.body).toBe("<p>second only</p>");
  });

  // set_doc on an ALREADY-LINKED doc must keep working exactly as before —
  // this is the item 1 definition-of-done arm this whole file leans on.
  test("set_doc on a ticket that already has a linked doc keeps working unchanged", async () => {
    const { ops, addIssue, seedIssueDoc, pages, issues } = makeWorld();
    addIssue("BUTCHR-67", "already linked");
    seedIssueDoc("BUTCHR-67", "804", "Existing doc", "<p>old</p>");
    const result = await setDoc(ops, "BUTCHR-67", "<p>new</p>");
    expect(result.title).toBe("Existing doc");
    expect(pages.get("804")!.body).toBe("<p>new</p>");
    expect(issues.get("BUTCHR-67")!.remoteLink).toBeTruthy();
  });

  // PR #112 review: retitling via set_doc must refresh the remote link's own
  // title too, not just the page's — the link is what a human actually sees
  // on the Jira ticket.
  test("retitling via set_doc refreshes the remote link's title, not just the page's", async () => {
    const { ops, addIssue, seedIssueDoc, issues } = makeWorld();
    addIssue("BUTCHR-65", "link must not go stale");
    seedIssueDoc("BUTCHR-65", "805", "[unwritten] BUTCHR-65 — link must not go stale", "<p/>");
    expect(issues.get("BUTCHR-65")!.remoteLink!.title).toBe("[unwritten] BUTCHR-65 — link must not go stale");
    // Retitling write: the link must now read the REAL title, not the stale provisional one.
    const result = await setDoc(ops, "BUTCHR-65", "<p>real content</p>", "A real outcome-shaped title");
    expect(result.title).toBe("A real outcome-shaped title");
    expect(issues.get("BUTCHR-65")!.remoteLink!.title).toBe("A real outcome-shaped title");
  });

  test("a body-only write (title omitted) does NOT re-upsert the link — no title changed, nothing to refresh", async () => {
    const { ops, addIssue, seedIssueDoc, upsertCalls } = makeWorld();
    addIssue("BUTCHR-66", "no spurious link writes");
    seedIssueDoc("BUTCHR-66", "806", "Outcome title", "<p>v0</p>");
    await setDoc(ops, "BUTCHR-66", "<p>v1</p>"); // body-only — title unchanged
    const callsAfterFirstWrite = upsertCalls();
    await setDoc(ops, "BUTCHR-66", "<p>v2</p>"); // body-only — title unchanged
    expect(upsertCalls()).toBe(callsAfterFirstWrite); // no additional upsert
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
  function seedRootDoc(pages: Map<string, { parentId: string; title: string; body: string; labels: string[]; version: number }>, id: string, title: string, body: string) {
    // A project's root doc is provisioned AHEAD OF TIME (BUTCHR-62's doc: six
    // product projects + ASSIST already carry one) — seeded directly here,
    // never via ensureDoc, matching that reality.
    pages.set(id, { parentId: "", title, body, labels: [], version: 1 });
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
  function seedRootDoc(pages: Map<string, { parentId: string; title: string; body: string; labels: string[]; version: number }>, id: string, title: string, body: string) {
    pages.set(id, { parentId: "", title, body, labels: [], version: 1 });
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
      const result = await getProjectDoc(ops, "CATA", offset, 5, offset === 0 ? undefined : 1);
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
      const result = await getProjectDoc(ops, "CATA", offset, 3, offset === 0 ? undefined : 1);
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
    const atPairStart = await getProjectDoc(ops, "CATA", 2, 1, 1);
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
    const result = await getProjectDoc(ops, "CATA", 10, 5, 1);
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
      await expect(getProjectDoc(ops, "CATA", 11, undefined, 1)).rejects.toThrow(/10 characters/);
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
      await expect(getProjectDoc(ops, "CATA", 0, 0, 1)).rejects.toThrow(/positive integer/);
    });
    test("non-integer limit refuses", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedRootDoc(pages, "960", "root doc", "0123456789");
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "960" } });
      await expect(getProjectDoc(ops, "CATA", 0, 2.5)).rejects.toThrow(/positive integer/);
    });
  });

  // -------------------------------------------------------------------------
  // BUTCHR-230 review: version drift across a multi-call read. The hazard is
  // the mirror of the one `body`-only-when-`complete` closes — there a caller
  // writes back TOO LITTLE, here it writes back a body that never existed at
  // any point in time. Both end at `set_doc`, a full-body replace. Closed the
  // same way: the bad state is made unreachable, not documented.
  describe("version drift (BUTCHR-230 review)", () => {
    test("THE RULE IS IN THE WARNING ITSELF — a partial tells the caller to pin expectVersion and to discard-and-restart on drift", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      pages.set("940", { parentId: "", title: "big doc", body: "x".repeat(100), labels: [], version: 1 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "940" } });
      const r: any = await getProjectDoc(ops, "CATA", 0, 10);
      expect(r.complete).toBe(false);
      // Would fail if a later edit drops the rule from the warning text — which
      // is the whole reason this asserts on prose rather than trusting it.
      expect(r.warning).toMatch(/expectVersion/);
      expect(r.warning).toMatch(/REQUIRED on every call with offset > 0/);
      expect(r.warning).toMatch(/NEVER concatenate chunks that came from different versions/);
      expect(r.warning).toMatch(/DISCARD every chunk/i);
      expect(r.warning).toMatch(/restart from offset 0/i);
    });

    test("expectVersion is REQUIRED once offset > 0 — the splice is unrepresentable, not merely discouraged", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      pages.set("941", { parentId: "", title: "big doc", body: "x".repeat(100), labels: [], version: 1 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "941" } });
      await expect(getProjectDoc(ops, "CATA", 10, 10)).rejects.toThrow(/expectVersion is required when offset > 0/);
      // offset 0 still needs nothing: a first slice has no earlier version to agree with.
      await expect(getProjectDoc(ops, "CATA", 0, 10)).resolves.toBeDefined();
    });

    test("a page edited mid-read REFUSES the continuation instead of splicing two versions", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      pages.set("942", { parentId: "", title: "edited doc", body: "x".repeat(100), labels: [], version: 3 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "942" } });
      const first: any = await getProjectDoc(ops, "CATA", 0, 10);
      expect(first.version).toBe(3);
      // somebody writes the page between slice 1 and slice 2
      pages.set("942", { ...pages.get("942")!, body: "y".repeat(100), version: 4 });
      await expect(getProjectDoc(ops, "CATA", first.next.offset, 10, first.version)).rejects.toThrow(/changed mid-read/);
      await expect(getProjectDoc(ops, "CATA", first.next.offset, 10, first.version)).rejects.toThrow(/restart from offset 0/);
    });

    test("an UNVERIFIABLE pin refuses too — a version that could not be read is not a satisfied pin", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      pages.set("943", { parentId: "", title: "versionless doc", body: "x".repeat(100), labels: [], version: 1 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "943" } });
      pages.set("943", { ...pages.get("943")!, version: undefined as any });
      await expect(getProjectDoc(ops, "CATA", 10, 10, 1)).rejects.toThrow(/unverifiable/);
    });

    test("a matching pin reads through, and the full paginated round trip still reconstructs exactly", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      const body = "a—b—c—d—e—f—g—h—i—j";
      pages.set("944", { parentId: "", title: "pinned doc", body, labels: [], version: 9 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "944" } });
      const first: any = await getProjectDoc(ops, "CATA", 0, 5);
      expect(first.version).toBe(9);
      let offset = first.next.offset, out = first.chunk, guard = 0;
      for (;;) {
        const r: any = await getProjectDoc(ops, "CATA", offset, 5, first.version);
        out += r.chunk;
        if (!r.next) break;
        offset = r.next.offset;
        if (++guard > 20) throw new Error("pagination did not terminate");
      }
      expect(out).toBe(body);
    });

    test("expectVersion shape is validated: non-integer and non-positive refuse", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      pages.set("945", { parentId: "", title: "doc", body: "x".repeat(100), labels: [], version: 1 });
      setProjectProperty("CATA", { space: { key: "CATA" }, rootDoc: { id: "945" } });
      await expect(getProjectDoc(ops, "CATA", 10, 10, 2.5)).rejects.toThrow(/expectVersion must be a positive integer/);
      await expect(getProjectDoc(ops, "CATA", 10, 10, 0)).rejects.toThrow(/expectVersion must be a positive integer/);
    });
  });

});

// ---------------------------------------------------------------------------
// BUTCHR-250: refuse a doc write IFF it is BOTH over DOC_BODY_CHAR_BUDGET AND
// larger than what's currently stored. Every arm below must be able to fail:
// dropping the second clause (the anti-bricking escape) would turn the
// "smaller than stored" arm into a false REFUSED; dropping the first clause
// would turn the "under budget" arm into a false-ALLOWED-forever guard that
// never fires at all. Project keys below are deliberately NOT "BUTCHR" — the
// guard must not be, even accidentally, project-specific.
// ---------------------------------------------------------------------------
describe("docs.ts: doc-write size budget (BUTCHR-250) — refuse only a write that is BOTH over budget AND growing", () => {
  function seedProjectRootDoc(
    pages: Map<string, { parentId: string; title: string; body: string; labels: string[] }>,
    setProjectProperty: (projectKey: string, value: unknown) => void,
    projectKey: string,
    pageId: string,
    title: string,
    body: string,
  ) {
    pages.set(pageId, { parentId: "", title, body, labels: [] });
    setProjectProperty(projectKey, { space: { key: projectKey }, rootDoc: { id: pageId } });
  }

  test("under budget: always allowed, regardless of stored size", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9001", "ACME — product brief", "<p>small stored body</p>");
    const proposed = "a".repeat(DOC_BODY_CHAR_BUDGET - 1);
    await expect(setProjectDoc(ops, "ACME", proposed)).resolves.toBeDefined();
    expect(pages.get("9001")!.body).toBe(proposed); // the write actually landed
  });

  test("over budget AND larger than stored: REFUSED, and the message names stored size, proposed size, budget, and the remedy", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const stored = "a".repeat(100);
    expect(stored.length).toBeLessThan(DOC_BODY_CHAR_BUDGET); // pin the fixture's floor, or this arm proves nothing
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9002", "ACME — product brief", stored);
    const proposed = "b".repeat(DOC_BODY_CHAR_BUDGET + 1);

    let caught: Error | undefined;
    try {
      await setProjectDoc(ops, "ACME", proposed);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(String(stored.length)); // current stored size
    expect(caught!.message).toContain(String(proposed.length)); // proposed size
    expect(caught!.message).toContain(String(DOC_BODY_CHAR_BUDGET)); // the budget
    expect(caught!.message).toMatch(/child page/); // the remedy
    expect(pages.get("9002")!.body).toBe(stored); // the refused write never landed
  });

  test("over budget but SMALLER than stored: allowed — the anti-bricking arm, most likely to break under a later 'simplification'", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const stored = "a".repeat(DOC_BODY_CHAR_BUDGET + 10_000);
    expect(stored.length).toBeGreaterThan(DOC_BODY_CHAR_BUDGET); // pin: the fixture itself must be over budget
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9003", "ACME — product brief", stored);
    const proposed = "b".repeat(DOC_BODY_CHAR_BUDGET + 5_000); // still over budget, but smaller than what's stored
    expect(proposed.length).toBeGreaterThan(DOC_BODY_CHAR_BUDGET);
    expect(proposed.length).toBeLessThan(stored.length);
    await expect(setProjectDoc(ops, "ACME", proposed)).resolves.toBeDefined();
    expect(pages.get("9003")!.body).toBe(proposed); // the shrink landed
  });

  test("over budget and EXACTLY EQUAL to stored: allowed — a same-size rewrite is not growth, decided and pinned deliberately", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    const stored = "a".repeat(DOC_BODY_CHAR_BUDGET + 2_000);
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9004", "ACME — product brief", stored);
    const proposed = "b".repeat(stored.length); // same length, different content
    await expect(setProjectDoc(ops, "ACME", proposed)).resolves.toBeDefined();
    expect(pages.get("9004")!.body).toBe(proposed);
  });

  test("the boundary itself: exactly at budget is allowed; one character over (against a small stored body) is refused", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9005", "ACME — product brief", "<p>tiny</p>");

    const atBudget = "a".repeat(DOC_BODY_CHAR_BUDGET);
    await expect(setProjectDoc(ops, "ACME", atBudget)).resolves.toBeDefined();
    expect(pages.get("9005")!.body).toBe(atBudget);

    const overByOne = "a".repeat(DOC_BODY_CHAR_BUDGET + 1);
    await expect(setProjectDoc(ops, "ACME", overByOne)).rejects.toThrow();
    expect(pages.get("9005")!.body).toBe(atBudget); // refused write never landed
  });

  test("NOT accidentally project-specific: the guard refuses/allows identically for project keys that are not BUTCHR", async () => {
    for (const projectKey of ["ACME", "ZORP"]) {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedProjectRootDoc(pages, setProjectProperty, projectKey, "1", `${projectKey} — product brief`, "<p>small</p>");
      await expect(setProjectDoc(ops, projectKey, "a".repeat(DOC_BODY_CHAR_BUDGET + 1))).rejects.toThrow(/refusing this write/);
      await expect(setProjectDoc(ops, projectKey, "a".repeat(DOC_BODY_CHAR_BUDGET - 1))).resolves.toBeDefined();
      expect(pages.get("1")!.body).toBe("a".repeat(DOC_BODY_CHAR_BUDGET - 1)); // the allowed one landed, the refused one didn't
    }
  });

  test("setDoc (the per-ticket write path) carries the SAME guard — BUTCHR-250's own scope decision: a growing per-ticket doc is a smaller problem than the shared root doc, but not a non-problem", async () => {
    const { ops, addIssue, issues, pages } = makeWorld();
    addIssue("BUTCHR-90", "a task with an oversized doc already");
    const stored = "a".repeat(DOC_BODY_CHAR_BUDGET + 1_000);
    expect(stored.length).toBeGreaterThan(DOC_BODY_CHAR_BUDGET); // pin: fixture must genuinely be over budget
    pages.set("900", { parentId: ROOT_DOC_ID, title: "A real title", body: stored, labels: [labelForKey("BUTCHR-90")], version: 1 });
    issues.get("BUTCHR-90")!.remoteLink = { title: "A real title", url: "https://fake.atlassian.net/wiki/pages/900" };

    // growing an already-oversized ticket doc: refused
    await expect(setDoc(ops, "BUTCHR-90", "b".repeat(stored.length + 1))).rejects.toThrow(/refusing this write/);
    expect(pages.get("900")!.body).toBe(stored); // refused write never landed
    // shrinking it: allowed
    const shrunk = "b".repeat(DOC_BODY_CHAR_BUDGET - 1);
    await expect(setDoc(ops, "BUTCHR-90", shrunk)).resolves.toBeDefined();
    expect(pages.get("900")!.body).toBe(shrunk);
  });

  // -------------------------------------------------------------------
  // Review finding (PR #299): Confluence's storage layer re-encodes at
  // least some characters (a literal em dash, a literal "Δ") into LONGER
  // named XML entities on round-trip. A comparison of RAW (un-normalised)
  // lengths can therefore be fooled: a proposed body that swaps entities
  // for their shorter literal form LOOKS smaller than what is stored, but
  // is measured too early — its real post-storage size is what matters,
  // and that can come back larger than what raw comparison suggested.
  // These arms use REAL non-ASCII characters (not "a".repeat(...)) because
  // that is exactly what a purely-ASCII fixture cannot ever catch.
  // -------------------------------------------------------------------
  test("REGRESSION (PR #299 review): a raw-looking shrink that actually grows once stored is still REFUSED", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    // stored: already over budget, no special characters.
    const stored = "b".repeat(60_000);
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9006", "ACME — product brief", stored);

    // proposed: RAW length (56,000) is smaller than stored (60,000) — a
    // pre-fix, raw-only comparison would have scored this as a shrink and
    // allowed it. But it carries 1,000 literal em dashes, each of which
    // Confluence's storage layer re-encodes to the 7-character "&mdash;" —
    // so its REAL stored size would be 55,000 + 1,000*7 = 62,000, which is
    // BOTH over budget and larger than the 60,000 currently stored.
    const proposed = "b".repeat(55_000) + "—".repeat(1_000);
    expect(proposed.length).toBeLessThan(stored.length); // pin: the raw comparison this bug relied on

    await expect(setProjectDoc(ops, "ACME", proposed)).rejects.toThrow(/refusing this write/);
    expect(pages.get("9006")!.body).toBe(stored); // refused write never landed — the page did not silently grow
  });

  test("a proposed body containing known-re-encoded characters that genuinely stays under budget once estimated is still allowed", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9007", "ACME — product brief", "<p>small</p>");

    // A handful of em dashes and curly quotes inflate the estimate, but not
    // past budget: comfortably allowed, and the estimate (not the raw
    // length) is what must clear the budget check.
    const proposed = "b".repeat(100) + "—’“”".repeat(5);
    await expect(setProjectDoc(ops, "ACME", proposed)).resolves.toBeDefined();
    expect(pages.get("9007")!.body).toBe(proposed);
  });

  // -------------------------------------------------------------------
  // Review finding (PR #299, THIRD round): `<`, `>`, `&` and `"` are
  // Confluence STORAGE-FORMAT SYNTAX (tag brackets, attribute quotes, an
  // entity's own leading "&"), not content the storage layer re-encodes.
  // The prior fix wrongly billed them as if they were, inflating any
  // realistic storage-markup body and causing FALSE REFUSALS of genuinely
  // under-budget writes — the opposite failure direction from the one this
  // bound exists to prevent. Nothing above this arm uses a "<p>...</p>"
  // shape, so nothing above it could have caught this.
  // -------------------------------------------------------------------
  test("REGRESSION (PR #299 review, round 3): realistic storage markup that is genuinely under budget is ALLOWED, not falsely refused for its own tag syntax", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    seedProjectRootDoc(pages, setProjectProperty, "ACME", "9008", "ACME — product brief", "<p>small</p>");

    // Realistic storage markup, heavy in the four syntax characters: a link
    // with a quoted href, a paragraph, and an already-present entity — the
    // exact shape the review measured being wrongly inflated.
    const unit = '<p>See <a href="https://example.com/x">a link</a> &mdash; done.</p>';
    const proposed = unit.repeat(600); // comfortably under budget in raw form
    expect(proposed.length).toBeLessThan(DOC_BODY_CHAR_BUDGET); // pin: genuinely under budget, not a boundary trick
    expect(proposed).toContain("<p>"); // pin: this IS the shape no earlier arm exercised

    await expect(setProjectDoc(ops, "ACME", proposed)).resolves.toBeDefined();
    expect(pages.get("9008")!.body).toBe(proposed); // allowed and landed — not refused for its own markup
  });
});

// ---------------------------------------------------------------------------
// BUTCHR-236 (story BUTCHR-235): set_doc's result is a BOUNDED RECEIPT, never
// the body it just wrote. The old echo (`{ id, url, title, body }`, `body`
// being the caller's OWN input argument) proved nothing about what actually
// landed and scaled with document size — a successful write to a large doc
// came back as an oversize error indistinguishable from a failed one. Pinned
// here, for BOTH callers (`setDoc`/issue and `setProjectDoc`/project — the
// root doc is the LARGEST document on this surface and the reason the epic
// exists, so covering only the issue path would fix nothing that matters):
// ordinary, oversize (named, with an asserted size floor so the fixture
// can't quietly shrink into decoration), entity-normalised read-back, and
// unconfirmed. What would make each of these fail is stated inline.
// ---------------------------------------------------------------------------
describe("docs.ts: set_doc / setProjectDoc — bounded receipt (BUTCHR-236)", () => {
  // The field-observed boundary (BUTCHR-236's own ticket): a set_doc call
  // whose write SUCCEEDED came back as "result (81,019 characters across 1
  // line) exceeds maximum allowed tokens". This establishes 81,019 is past
  // the boundary; it does not establish where the boundary is, and the
  // receipt contract doesn't need to know — it must stay bounded at ANY size.
  const FIELD_OBSERVED_OVERSIZE_CHARS = 81_019;

  function seedProjectRootDoc(pages: Map<string, { parentId: string; title: string; body: string; labels: string[]; version: number }>, id: string, title: string, body: string) {
    pages.set(id, { parentId: "", title, body, labels: [], version: 1 });
  }

  describe("issue caller (setDoc)", () => {
    test('ordinary small write — receipt correct, landed: "confirmed"', async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-910", "ordinary write");
      seedIssueDoc("BUTCHR-910", "9100", "pre-existing doc", "<p>v0</p>");
      const body = "<p>hello</p>";
      const result = await setDoc(ops, "BUTCHR-910", body, "Ordinary write");
      // Would fail if: the receipt ever carries the body itself, in any field.
      expect(JSON.stringify(result)).not.toContain("hello");
      expect(result.landed).toBe("confirmed");
      expect(result.wrote).toEqual({ chars: body.length, bytes: Buffer.byteLength(body, "utf8"), sha256: expect.any(String) });
      expect(result.stored).toEqual(result.wrote); // the fake world doesn't rewrite plain ASCII — a genuine byte-identical landing
      expect(result.identical).toBe(true);
      expect(typeof result.version).toBe("number");
      expect(JSON.stringify(result).length).toBeLessThan(500); // bounded — a few hundred bytes, per the contract
    });

    test("the oversize arm, named as such — a body far past the field-observed 81,019-char boundary", async () => {
      const { ops, addIssue, pages, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-911", "oversize write");
      const body = `<p>${"x".repeat(200_000)}</p>`;
      // Would fail if: a later edit shrinks this fixture back under the boundary that actually broke — loudly, not as silent decoration.
      expect(body.length).toBeGreaterThan(FIELD_OBSERVED_OVERSIZE_CHARS * 2);
      // Pre-seed an already-larger stored body (BUTCHR-250's doc-write budget
      // guard, merged into this same file/verb, refuses a GROWING over-budget
      // write). This test is about the receipt staying bounded for a huge
      // WRITE, not about growth direction, so seed the pre-write state
      // directly to make this write a non-growing update — still far past
      // the 81,019-char boundary either way.
      seedIssueDoc("BUTCHR-911", "9110", "pre-existing doc", "y".repeat(body.length + 10_000));
      const result = await setDoc(ops, "BUTCHR-911", body, "Oversize write");
      // (a) the serialised RECEIPT stays small regardless of document size —
      // would fail if the old echo-the-body shape ever came back.
      expect(JSON.stringify(result).length).toBeLessThan(500);
      expect(result.landed).toBe("confirmed");
      // (b) the WRITE ITSELF still landed byte-for-byte — read the fake
      // STORE, never the receipt, for that half (the receipt is bounded and
      // therefore structurally incapable of proving this on its own).
      const stored = [...pages.values()].find((p) => p.title === "Oversize write");
      expect(stored?.body).toBe(body);
    });

    test('entity-normalised read-back — landed stays "confirmed", no throw, both digests and sizes still reported', async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-912", "normalised write");
      seedIssueDoc("BUTCHR-912", "9120", "pre-existing doc", "<p>v0</p>");
      // Simulates the MEASURED Confluence behaviour (this ticket): storage
      // XHTML is normalised on write, on ordinary prose — a literal em dash
      // and quotation mark read back as `&mdash;`/`&quot;`. Forced here at
      // the fake's getPage, since the in-memory fake store doesn't do this
      // itself.
      const normalisingOps: AtlassianOps = {
        ...ops,
        getPage: async (id: string) => {
          const page = (await ops.getPage(id)) as { body?: { storage?: { value?: string } } };
          const raw = page.body?.storage?.value ?? "";
          return { ...page, body: { storage: { value: raw.replaceAll("—", "&mdash;").replaceAll('"', "&quot;") } } };
        },
      };
      const body = '<p>an em dash — and a "quote"</p>';
      const result = await setDoc(normalisingOps, "BUTCHR-912", body, "Normalised write");
      // Pins the measured behaviour so nobody later "fixes" it into an error.
      expect(result.landed).toBe("confirmed");
      expect(result.identical).toBe(false); // EXPECTED on a healthy write, never an error
      expect(result.stored).not.toBeNull();
      expect(result.stored!.chars).toBeGreaterThan(result.wrote.chars); // normalisation makes stored LARGER
      expect(result.stored!.bytes).toBeGreaterThan(result.wrote.bytes);
      expect(result.stored!.sha256).not.toBe(result.wrote.sha256);
    });

    test('"unconfirmed" (read-back throws) — the call resolves, does not throw, identical/stored are null', async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-913", "unconfirmable write");
      // Pre-existing doc, titled already, so the call under test isolates the
      // failure to the CONFIRMATION read (buildReceipt's own getPage).
      seedIssueDoc("BUTCHR-913", "9130", "Unconfirmable write", "<p>v1</p>");
      let getPageCalls = 0;
      const flakyOps: AtlassianOps = {
        ...ops,
        getPage: async (id: string) => {
          getPageCalls++;
          if (getPageCalls > 1) throw new Error("simulated Confluence read-back outage");
          return ops.getPage(id); // findDoc's own resolve-current-doc read — must still succeed
        },
      };
      const result = await setDoc(flakyOps, "BUTCHR-913", "<p>v2</p>");
      expect(result.landed).toBe("unconfirmed");
      expect(result.identical).toBeNull();
      expect(result.stored).toBeNull();
      expect(getPageCalls).toBeGreaterThan(1); // confirms the confirmation read was actually attempted, not skipped
    });

    test('"unconfirmed" (read-back resolves with no body) — the call resolves, does not throw, identical/stored are null', async () => {
      const { ops, addIssue, seedIssueDoc } = makeWorld();
      addIssue("BUTCHR-914", "malformed read-back");
      seedIssueDoc("BUTCHR-914", "9140", "Malformed read-back", "<p>v1</p>");
      let getPageCalls = 0;
      const malformedOps: AtlassianOps = {
        ...ops,
        getPage: async (id: string) => {
          getPageCalls++;
          if (getPageCalls > 1) return { title: "whatever" }; // resolves — but with no body.storage.value at all
          return ops.getPage(id);
        },
      };
      const result = await setDoc(malformedOps, "BUTCHR-914", "<p>v2</p>");
      expect(result.landed).toBe("unconfirmed");
      expect(result.identical).toBeNull();
      expect(result.stored).toBeNull();
    });
  });

  describe("project caller (setProjectDoc)", () => {
    test('ordinary small write — receipt correct, landed: "confirmed"', async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedProjectRootDoc(pages, "20", "PROJ — product brief", "<p>stale</p>");
      setProjectProperty("PROJ", { space: { key: "PROJ" }, rootDoc: { id: "20" } });
      const body = "<p>current</p>";
      const result = await setProjectDoc(ops, "PROJ", body);
      expect(JSON.stringify(result)).not.toContain("current");
      expect(result.landed).toBe("confirmed");
      expect(result.wrote).toEqual({ chars: body.length, bytes: Buffer.byteLength(body, "utf8"), sha256: expect.any(String) });
      expect(result.stored).toEqual(result.wrote);
      expect(result.identical).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(500);
    });

    test("the oversize arm, named as such — a body far past the field-observed 81,019-char boundary, on the root doc (the largest document on this surface)", async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      const body = `<p>${"y".repeat(200_000)}</p>`;
      expect(body.length).toBeGreaterThan(FIELD_OBSERVED_OVERSIZE_CHARS * 2);
      // Seeded already-larger than `body` — see the issue-caller oversize
      // arm's comment above: BUTCHR-250's doc-write budget guard, sharing
      // this same write path, refuses a GROWING over-budget write, and this
      // test is about the receipt staying bounded for a huge write, not
      // about growth direction.
      seedProjectRootDoc(pages, "21", "BIG — product brief", "y".repeat(body.length + 10_000));
      setProjectProperty("BIG", { space: { key: "BIG" }, rootDoc: { id: "21" } });
      const result = await setProjectDoc(ops, "BIG", body);
      expect(JSON.stringify(result).length).toBeLessThan(500);
      expect(result.landed).toBe("confirmed");
      expect(pages.get("21")?.body).toBe(body); // the write landed byte-for-byte — read the fake STORE, not the receipt
    });

    test('entity-normalised read-back — landed stays "confirmed", no throw, both digests and sizes still reported', async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedProjectRootDoc(pages, "22", "NORM — product brief", "<p>stale</p>");
      setProjectProperty("NORM", { space: { key: "NORM" }, rootDoc: { id: "22" } });
      const normalisingOps: AtlassianOps = {
        ...ops,
        getPage: async (id: string) => {
          const page = (await ops.getPage(id)) as { body?: { storage?: { value?: string } } };
          const raw = page.body?.storage?.value ?? "";
          return { ...page, body: { storage: { value: raw.replaceAll("—", "&mdash;") } } };
        },
      };
      const body = "<p>an em dash — right here</p>";
      const result = await setProjectDoc(normalisingOps, "NORM", body);
      expect(result.landed).toBe("confirmed");
      expect(result.identical).toBe(false);
      expect(result.stored).not.toBeNull();
      expect(result.stored!.chars).toBeGreaterThan(result.wrote.chars);
      expect(result.stored!.sha256).not.toBe(result.wrote.sha256);
    });

    test('"unconfirmed" — read-back fails after a successful write; resolves, does not throw, identical/stored are null', async () => {
      const { ops, pages, setProjectProperty } = makeWorld();
      seedProjectRootDoc(pages, "23", "FLKY — product brief", "<p>v1</p>");
      setProjectProperty("FLKY", { space: { key: "FLKY" }, rootDoc: { id: "23" } });
      let getPageCalls = 0;
      const flakyOps: AtlassianOps = {
        ...ops,
        getPage: async (id: string) => {
          getPageCalls++;
          if (getPageCalls > 1) throw new Error("simulated Confluence read-back outage");
          return ops.getPage(id); // projectRootDoc's own resolve-current-doc read — must still succeed
        },
      };
      const result = await setProjectDoc(flakyOps, "FLKY", "<p>v2</p>");
      expect(result.landed).toBe("unconfirmed");
      expect(result.identical).toBeNull();
      expect(result.stored).toBeNull();
      // Would fail if: the write itself never happened either — but it must (updatePage runs BEFORE the failing confirmation read).
      expect(pages.get("23")?.body).toBe("<p>v2</p>");
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
