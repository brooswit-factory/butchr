import { describe, expect, test } from "bun:test";
import type { JiraComment } from "../../src/atlassian/types.js";
import { UnsupportedCapabilityError, type CapabilityRef } from "../../src/resources/capabilities.js";
import { addComment, readComments } from "../../src/resources/comments.js";

/** A fake Jira comment client — the interface-mock pattern this repo already
 * uses for jira-idea (test/unit/jira-idea.test.ts's `createJiraIdeaClient(jira)`
 * with a plain object), not a fake `fetch`: never hits the network. */
function fakeClient(comments: JiraComment[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async allComments(issueKey: string) {
        calls.push({ method: "allComments", args: [issueKey] });
        return comments;
      },
      async addComment(issueKey: string, text: string) {
        calls.push({ method: "addComment", args: [issueKey, text] });
        return { id: "900", body: text, created: "2026-09-25T00:00:00.000Z", authorEmail: "bot@example.com" } satisfies JiraComment;
      },
    },
  };
}

const WORK_REF: CapabilityRef = { provider: "jira-work-item", key: "BUTCHR-1" };
const UNSUPPORTED_REFS: CapabilityRef[] = [
  { provider: "jira-project", key: "BUTCHR" },
  { provider: "jira-idea", key: "IDEA-1" },
  { provider: "confluence-page", pageId: "123456" },
  { provider: "github-issue", owner: "brooswit-factory", repo: "butchr", number: 1 },
  { provider: "zendesk-ticket", subdomain: "acme", id: 1 },
  { provider: "filesystem", path: "/srv/factory/butchr" },
  { provider: "webpage", url: "https://example.com/resource" },
];

describe("readComments/addComment: jira-work-item goes through the shared Atlassian client, reusing its native comment methods", () => {
  test("readComments maps AtlassianClient.allComments's oldest-first result onto the canonical Comment shape, unchanged order", async () => {
    const raw: JiraComment[] = [
      { id: "1", body: "first", created: "2026-09-01T00:00:00.000Z", authorEmail: "alice@example.com" },
      { id: "2", body: "second", created: "2026-09-02T00:00:00.000Z", authorEmail: null },
    ];
    const { client, calls } = fakeClient(raw);
    const result = await readComments(client, WORK_REF);
    expect(result).toEqual([
      { id: "1", author: "alice@example.com", timestamp: "2026-09-01T00:00:00.000Z", body: "first" },
      { id: "2", author: null, timestamp: "2026-09-02T00:00:00.000Z", body: "second" },
    ]);
    expect(calls).toEqual([{ method: "allComments", args: ["BUTCHR-1"] }]);
  });

  test("addComment posts through AtlassianClient.addComment and returns a CommentRef naming the new comment's id", async () => {
    const { client, calls } = fakeClient([]);
    expect(await addComment(client, WORK_REF, "hello")).toEqual({ id: "900" });
    expect(calls).toEqual([{ method: "addComment", args: ["BUTCHR-1", "hello"] }]);
  });

  test("an empty comment list round-trips to an empty array, not an error", async () => {
    const { client } = fakeClient([]);
    expect(await readComments(client, WORK_REF)).toEqual([]);
  });
});

describe("readComments/addComment: every other provider fails with the typed UnsupportedCapabilityError, never touching the client", () => {
  for (const ref of UNSUPPORTED_REFS) {
    test(`${ref.provider}: readComments/addComment refuse before any client call`, async () => {
      const { client, calls } = fakeClient([{ id: "1", body: "x", created: "c", authorEmail: null }]);
      await expect(readComments(client, ref)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      await expect(addComment(client, ref, "x")).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(calls).toEqual([]);
    });

    test(`${ref.provider}: the thrown error carries the provider and "comments", not a generic message`, async () => {
      const { client } = fakeClient([]);
      let caught: unknown;
      try { await readComments(client, ref); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(UnsupportedCapabilityError);
      const err = caught as UnsupportedCapabilityError;
      expect(err.provider).toBe(ref.provider);
      expect(err.capability).toBe("comments");
    });
  }
});
