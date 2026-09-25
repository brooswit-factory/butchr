import { describe, expect, test } from "bun:test";
import type { JiraComment } from "../../src/atlassian/types.js";
import { UnsupportedCapabilityError, type CapabilityRef } from "../../src/resources/capabilities.js";
import { addComment, readComments, type CommentClients } from "../../src/resources/comments.js";

/** A fake Jira comment client — the interface-mock pattern this repo already
 * uses for jira-idea (test/unit/jira-idea.test.ts's `createJiraIdeaClient(jira)`
 * with a plain object), not a fake `fetch`: never hits the network. Shared by
 * jira-work-item (calls `allComments`/`addComment` directly) and jira-idea
 * (whose own client delegates `comments` to the exact same shape). */
function fakeJiraClient(comments: JiraComment[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async allComments(issueKey: string) {
        calls.push({ method: "allComments", args: [issueKey] });
        return comments;
      },
      async comments(issueKey: string) {
        calls.push({ method: "comments", args: [issueKey] });
        return comments;
      },
      async addComment(issueKey: string, text: string) {
        calls.push({ method: "addComment", args: [issueKey, text] });
        return { id: "900", body: text, created: "2026-09-25T00:00:00.000Z", authorEmail: "bot@example.com" } satisfies JiraComment;
      },
    },
  };
}

function fakeGithubClient(comments: Array<{ id: string; author: string | null; body: string; created: string; updated: string }>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async comments(ref: { owner: string; repo: string; number: number }) {
        calls.push({ method: "comments", args: [ref] });
        return comments;
      },
      async addComment(ref: { owner: string; repo: string; number: number }, body: string) {
        calls.push({ method: "addComment", args: [ref, body] });
        return { id: "901", author: "bot-user", body, created: "2026-09-25T00:00:00.000Z", updated: "2026-09-25T00:00:00.000Z" };
      },
    },
  };
}

function fakeZendeskClient(
  comments: Array<{ id: string; authorId: number | null; public: boolean; body: string; created: string }>,
  noteResult: { id: string | null; confirmedPrivate: boolean; updated: string | null } = { id: "902", confirmedPrivate: true, updated: "2026-09-25T00:00:00.000Z" },
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async comments(ref: { subdomain: string; id: number }) {
        calls.push({ method: "comments", args: [ref] });
        return comments;
      },
      async addInternalNote(ref: { subdomain: string; id: number }, body: string) {
        calls.push({ method: "addInternalNote", args: [ref, body] });
        return noteResult;
      },
    },
  };
}

const WORK_REF: CapabilityRef = { provider: "jira-work-item", key: "BUTCHR-1" };
const IDEA_REF: CapabilityRef = { provider: "jira-idea", key: "IDEA-1" };
const GITHUB_REF: CapabilityRef = { provider: "github-issue", owner: "brooswit-factory", repo: "butchr", number: 7 };
const ZENDESK_REF: CapabilityRef = { provider: "zendesk-ticket", subdomain: "acme", id: 42 };

function fakeConfluenceClient(
  results: Array<{ id: string; body: string; author?: string; created?: string }>,
  commentOnPageResult: unknown = { id: "930" },
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async getPageComments(pageId: string) {
        calls.push({ method: "getPageComments", args: [pageId] });
        return { results };
      },
      async commentOnPage(pageId: string, body: string) {
        calls.push({ method: "commentOnPage", args: [pageId, body] });
        return commentOnPageResult;
      },
    },
  };
}

const CONFLUENCE_REF: CapabilityRef = { provider: "confluence-page", pageId: "123456" };

const UNSUPPORTED_REFS: CapabilityRef[] = [
  { provider: "jira-project", key: "BUTCHR" },
  { provider: "filesystem", path: "/srv/factory/butchr" },
  { provider: "webpage", url: "https://example.com/resource" },
];

describe("readComments/addComment: jira-work-item goes through the shared Atlassian client, reusing its native comment methods", () => {
  test("readComments maps AtlassianClient.allComments's oldest-first result onto the canonical Comment shape, unchanged order", async () => {
    const raw: JiraComment[] = [
      { id: "1", body: "first", created: "2026-09-01T00:00:00.000Z", authorEmail: "alice@example.com" },
      { id: "2", body: "second", created: "2026-09-02T00:00:00.000Z", authorEmail: null },
    ];
    const { client, calls } = fakeJiraClient(raw);
    const clients: CommentClients = { "jira-work-item": client };
    const result = await readComments(clients, WORK_REF);
    expect(result).toEqual([
      { id: "1", author: "alice@example.com", timestamp: "2026-09-01T00:00:00.000Z", body: "first" },
      { id: "2", author: null, timestamp: "2026-09-02T00:00:00.000Z", body: "second" },
    ]);
    expect(calls).toEqual([{ method: "allComments", args: ["BUTCHR-1"] }]);
  });

  test("addComment posts through AtlassianClient.addComment and returns a CommentRef naming the new comment's id", async () => {
    const { client, calls } = fakeJiraClient([]);
    const clients: CommentClients = { "jira-work-item": client };
    expect(await addComment(clients, WORK_REF, "hello")).toEqual({ id: "900" });
    expect(calls).toEqual([{ method: "addComment", args: ["BUTCHR-1", "hello"] }]);
  });

  test("an empty comment list round-trips to an empty array, not an error", async () => {
    const { client } = fakeJiraClient([]);
    expect(await readComments({ "jira-work-item": client }, WORK_REF)).toEqual([]);
  });

  test("a client rejection propagates rather than being swallowed", async () => {
    const client = { allComments: async () => { throw new Error("Jira comments for BUTCHR-1 exceed 1000 — refusing a partial list"); }, addComment: async () => { throw new Error("unreached"); } };
    await expect(readComments({ "jira-work-item": client }, WORK_REF)).rejects.toThrow("exceed 1000");
  });
});

describe("readComments/addComment: jira-idea reuses JiraIdeaClient.comments/.addComment (which itself re-verifies via get() before every write)", () => {
  test("readComments maps jira-idea's comments (same shape/order as jira-work-item) onto the canonical Comment shape", async () => {
    const raw: JiraComment[] = [{ id: "3", body: "shape it", created: "2026-09-03T00:00:00.000Z", authorEmail: "pm@example.com" }];
    const { client, calls } = fakeJiraClient(raw);
    const result = await readComments({ "jira-idea": client }, IDEA_REF);
    expect(result).toEqual([{ id: "3", author: "pm@example.com", timestamp: "2026-09-03T00:00:00.000Z", body: "shape it" }]);
    expect(calls).toEqual([{ method: "comments", args: ["IDEA-1"] }]);
  });

  test("addComment posts through JiraIdeaClient.addComment and returns a CommentRef", async () => {
    const { client, calls } = fakeJiraClient([]);
    expect(await addComment({ "jira-idea": client }, IDEA_REF, "looks good")).toEqual({ id: "900" });
    expect(calls).toEqual([{ method: "addComment", args: ["IDEA-1", "looks good"] }]);
  });

  test("a client rejection (e.g. the idea's own get()-then-act re-verification failing) propagates", async () => {
    const client = { comments: async () => [], addComment: async () => { throw new Error("IDEA-1 is not a Jira Product Discovery idea"); } };
    await expect(addComment({ "jira-idea": client }, IDEA_REF, "x")).rejects.toThrow("is not a Jira Product Discovery idea");
  });
});

describe("readComments/addComment: github-issue reuses GithubIssueClient.comments/.addComment", () => {
  test("readComments maps GithubComment's oldest-first result onto the canonical Comment shape", async () => {
    const raw = [
      { id: "10", author: "alice", body: "first", created: "2026-09-01T00:00:00.000Z", updated: "2026-09-01T00:00:00.000Z" },
      { id: "11", author: null, body: "second", created: "2026-09-02T00:00:00.000Z", updated: "2026-09-02T00:00:00.000Z" },
    ];
    const { client, calls } = fakeGithubClient(raw);
    const result = await readComments({ "github-issue": client }, GITHUB_REF);
    expect(result).toEqual([
      { id: "10", author: "alice", timestamp: "2026-09-01T00:00:00.000Z", body: "first" },
      { id: "11", author: null, timestamp: "2026-09-02T00:00:00.000Z", body: "second" },
    ]);
    expect(calls).toEqual([{ method: "comments", args: [{ owner: "brooswit-factory", repo: "butchr", number: 7 }] }]);
  });

  test("addComment posts through GithubIssueClient.addComment and returns a CommentRef", async () => {
    const { client, calls } = fakeGithubClient([]);
    expect(await addComment({ "github-issue": client }, GITHUB_REF, "hi")).toEqual({ id: "901" });
    expect(calls).toEqual([{ method: "addComment", args: [{ owner: "brooswit-factory", repo: "butchr", number: 7 }, "hi"] }]);
  });

  test("a client rejection (e.g. the issue turning out to be a pull request) propagates", async () => {
    const client = { comments: async () => [], addComment: async () => { throw new Error("brooswit-factory/butchr#7 is a pull request, not an issue"); } };
    await expect(addComment({ "github-issue": client }, GITHUB_REF, "x")).rejects.toThrow("is a pull request, not an issue");
  });
});

describe("readComments/addComment: zendesk-ticket reuses ZendeskTicketClient.comments/addInternalNote — private-note-only, no public-reply path", () => {
  test("readComments maps ZendeskComment's oldest-first result onto the canonical Comment shape, stringifying the numeric author id", async () => {
    const raw = [
      { id: "20", authorId: 7, public: true, body: "any update?", created: "2026-09-01T00:00:00.000Z" },
      { id: "21", authorId: null, public: false, body: "internal note", created: "2026-09-02T00:00:00.000Z" },
    ];
    const { client, calls } = fakeZendeskClient(raw);
    const result = await readComments({ "zendesk-ticket": client }, ZENDESK_REF);
    expect(result).toEqual([
      { id: "20", author: "7", timestamp: "2026-09-01T00:00:00.000Z", body: "any update?" },
      { id: "21", author: null, timestamp: "2026-09-02T00:00:00.000Z", body: "internal note" },
    ]);
    expect(calls).toEqual([{ method: "comments", args: [{ subdomain: "acme", id: 42 }] }]);
  });

  test("addComment posts through addInternalNote (never a public reply) and returns a CommentRef", async () => {
    const { client, calls } = fakeZendeskClient([]);
    expect(await addComment({ "zendesk-ticket": client }, ZENDESK_REF, "looked into it")).toEqual({ id: "902" });
    expect(calls).toEqual([{ method: "addInternalNote", args: [{ subdomain: "acme", id: 42 }, "looked into it"] }]);
  });

  test("a null note id (addInternalNote's audit didn't carry one) is a rejection, never a faked CommentRef — and says the note WAS already posted, so a caller must not retry", async () => {
    const { client } = fakeZendeskClient([], { id: null, confirmedPrivate: false, updated: "2026-09-25T00:00:00.000Z" });
    await expect(addComment({ "zendesk-ticket": client }, ZENDESK_REF, "x")).rejects.toThrow("WAS posted, but its id could not be confirmed");
    await expect(addComment({ "zendesk-ticket": client }, ZENDESK_REF, "x")).rejects.toThrow("do not retry");
  });

  test("a client rejection (e.g. Zendesk recording the note as public) propagates", async () => {
    const client = { comments: async () => [], addInternalNote: async () => { throw new Error("Zendesk recorded the note on acme#42 as public"); } };
    await expect(addComment({ "zendesk-ticket": client }, ZENDESK_REF, "x")).rejects.toThrow("recorded the note on acme#42 as public");
  });
});

describe("readComments/addComment: confluence-page reuses AtlassianOps.getPageComments/commentOnPage (FACTORY-29/31) — footer comments only", () => {
  test("readComments maps AtlassianOps.getPageComments' fields onto the canonical Comment shape, body left as storage-format XHTML", async () => {
    const raw = [{ id: "40", body: "<p>hi</p>", author: "abc123", created: "2026-09-01T00:00:00.000Z" }];
    const { client, calls } = fakeConfluenceClient(raw);
    const result = await readComments({ "confluence-page": client }, CONFLUENCE_REF);
    expect(result).toEqual([{ id: "40", author: "abc123", timestamp: "2026-09-01T00:00:00.000Z", body: "<p>hi</p>" }]);
    expect(calls).toEqual([{ method: "getPageComments", args: ["123456"] }]);
  });

  test("a comment with no author/created maps author to null and timestamp to an empty string, never fabricated", async () => {
    const raw = [{ id: "41", body: "<p>no metadata</p>" }];
    const { client } = fakeConfluenceClient(raw);
    const result = await readComments({ "confluence-page": client }, CONFLUENCE_REF);
    expect(result).toEqual([{ id: "41", author: null, timestamp: "", body: "<p>no metadata</p>" }]);
  });

  test("readComments sorts oldest-first even when getPageComments returns newest-first (no server-side sort is ever requested)", async () => {
    const raw = [
      { id: "50", body: "third", created: "2026-09-03T00:00:00.000Z" },
      { id: "51", body: "first", created: "2026-09-01T00:00:00.000Z" },
      { id: "52", body: "second", created: "2026-09-02T00:00:00.000Z" },
    ];
    const { client } = fakeConfluenceClient(raw);
    const result = await readComments({ "confluence-page": client }, CONFLUENCE_REF);
    expect(result.map((c) => c.id)).toEqual(["51", "52", "50"]);
  });

  test("comments missing `created` sort after every dated comment, keeping their own relative order (stable sort)", async () => {
    const raw = [
      { id: "60", body: "undated A" },
      { id: "61", body: "dated", created: "2026-09-02T00:00:00.000Z" },
      { id: "62", body: "undated B" },
    ];
    const { client } = fakeConfluenceClient(raw);
    const result = await readComments({ "confluence-page": client }, CONFLUENCE_REF);
    expect(result.map((c) => c.id)).toEqual(["61", "60", "62"]);
  });

  test("pagination is AtlassianOps.getPageComments' own job — not re-tested here — but a thrown read propagates as a rejection, never a partial list", async () => {
    const client = {
      getPageComments: async () => { throw new Error("getPageComments(123456): exceeded 100 pages without the cursor running out"); },
      commentOnPage: async () => { throw new Error("unreached"); },
    };
    await expect(readComments({ "confluence-page": client }, CONFLUENCE_REF)).rejects.toThrow("exceeded 100 pages");
  });

  test("addComment converts a plain sentence into a single <p> paragraph, HTML-escaping nothing that needs no escaping", async () => {
    const { client, calls } = fakeConfluenceClient([]);
    await addComment({ "confluence-page": client }, CONFLUENCE_REF, "Hello world");
    expect(calls).toEqual([{ method: "commentOnPage", args: ["123456", "<p>Hello world</p>"] }]);
  });

  test("addComment HTML-escapes & < > \" ' so a caller passing them never posts malformed/misrendered storage XHTML", async () => {
    const { client, calls } = fakeConfluenceClient([]);
    await addComment({ "confluence-page": client }, CONFLUENCE_REF, `a < b & c > "d" 'e'`);
    expect(calls).toEqual([{ method: "commentOnPage", args: ["123456", "<p>a &lt; b &amp; c &gt; &quot;d&quot; &#39;e&#39;</p>"] }]);
  });

  test("addComment turns each blank-line-separated paragraph into its own <p>, and a single newline within a paragraph into <br/>", async () => {
    const { client, calls } = fakeConfluenceClient([]);
    await addComment({ "confluence-page": client }, CONFLUENCE_REF, "First para line one\nFirst para line two\n\nSecond para");
    expect(calls).toEqual([{ method: "commentOnPage", args: ["123456", "<p>First para line one<br/>First para line two</p><p>Second para</p>"] }]);
  });

  test("addComment posts through commentOnPage and returns a CommentRef when the response carries a usable id", async () => {
    const { client } = fakeConfluenceClient([], { id: "930" });
    expect(await addComment({ "confluence-page": client }, CONFLUENCE_REF, "looks good")).toEqual({ id: "930" });
  });

  test("a missing/unusable id from commentOnPage is a rejection, never a faked CommentRef — and says the comment WAS posted, so a caller must not retry", async () => {
    const { client } = fakeConfluenceClient([], {});
    await expect(addComment({ "confluence-page": client }, CONFLUENCE_REF, "x")).rejects.toThrow("WAS posted, but its id could not be confirmed");
    await expect(addComment({ "confluence-page": client }, CONFLUENCE_REF, "x")).rejects.toThrow("do not retry");
  });

  test("a null/non-object commentOnPage response is also treated as a missing id, not a crash", async () => {
    const { client } = fakeConfluenceClient([], null);
    await expect(addComment({ "confluence-page": client }, CONFLUENCE_REF, "x")).rejects.toThrow("WAS posted, but its id could not be confirmed");
  });

  test("a client rejection (e.g. an invalid page id) propagates", async () => {
    const client = { getPageComments: async () => ({ results: [] }), commentOnPage: async () => { throw new Error("Atlassian 404 on page 123456"); } };
    await expect(addComment({ "confluence-page": client }, CONFLUENCE_REF, "x")).rejects.toThrow("Atlassian 404");
  });
});

describe("a capability declared supported but given no matching client in the bag fails loudly, not silently", () => {
  test("readComments/addComment throw a plain Error (not UnsupportedCapabilityError) naming the missing provider", async () => {
    await expect(readComments({}, WORK_REF)).rejects.toThrow("no jira-work-item client");
    await expect(addComment({}, IDEA_REF, "x")).rejects.toThrow("no jira-idea client");
    await expect(readComments({}, CONFLUENCE_REF)).rejects.toThrow("no confluence-page client");
    const err = await readComments({}, GITHUB_REF).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe("readComments/addComment: every unsupported provider fails with the typed UnsupportedCapabilityError, never touching a client", () => {
  for (const ref of UNSUPPORTED_REFS) {
    test(`${ref.provider}: readComments/addComment refuse before any client call`, async () => {
      const { client, calls } = fakeJiraClient([{ id: "1", body: "x", created: "c", authorEmail: null }]);
      const clients: CommentClients = { "jira-work-item": client };
      await expect(readComments(clients, ref)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      await expect(addComment(clients, ref, "x")).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(calls).toEqual([]);
    });

    test(`${ref.provider}: the thrown error carries the provider and "comments", not a generic message`, async () => {
      let caught: unknown;
      try { await readComments({}, ref); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(UnsupportedCapabilityError);
      const err = caught as UnsupportedCapabilityError;
      expect(err.provider).toBe(ref.provider);
      expect(err.capability).toBe("comments");
    });
  }
});
