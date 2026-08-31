import { describe, expect, test } from "bun:test";
import { ApiError } from "confluence.js/core";
import { getDoc, setDoc, ensureDoc, labelForKey, JIRA_KEY_RE } from "../../src/tools/docs.js";
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
  const pages = new Map<string, { parentId: string; title: string; body: string; labels: string[] }>();
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
    createPage: async () => ({}),
    getPage: async (id: string) => {
      const p = pages.get(id);
      if (!p) throw new Error(`fake world: no such page ${id}`);
      return { title: p.title, body: { storage: { value: p.body } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } };
    },
    updatePage: async (p) => {
      const page = pages.get(p.id);
      if (!page) throw new Error(`fake world: no such page ${p.id}`);
      page.body = p.body;
      if (p.title) page.title = p.title;
      return { ok: true };
    },
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    addLabels: async () => ({ ok: true }),
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
  };

  return { ops, issues, pages, projectProperties, addIssue, setProjectProperty, upsertCalls: () => upsertRemoteLinkCalls };
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

  test("a ticket with a doc returns its body/id/url", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-2", "already has a doc");
    const created = await ensureDoc(ops, "BUTCHR-2");
    const result = await getDoc(ops, "BUTCHR-2");
    expect(result).toEqual({ found: true, id: created.id, url: created.url, title: created.title, body: created.body });
    expect(pages.size).toBe(1);
  });

  test("refuses a malformed key without touching any op", async () => {
    const { ops } = makeWorld();
    await expect(getDoc(ops, "not-a-key")).rejects.toThrow(/not a valid Jira key/);
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
