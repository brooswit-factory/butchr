import { describe, expect, test } from "bun:test";
import { AtlassianClient, adfToText } from "../../src/atlassian/client.js";

function fakeFetch(routes: Record<string, unknown>, seen: { url: string; auth: string | undefined }[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("AtlassianClient", () => {
  test("search maps issues and sends Basic auth", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const c = new AtlassianClient("https://x.atlassian.net", "a@b.c", "tok", fakeFetch({
      "/search/jql": { issues: [{ key: "KAN-1", fields: { summary: "s", status: { name: "In Progress" }, issuetype: { name: "Task" }, assignee: { displayName: "Ada" }, updated: "2026-08-24" } }] },
    }, seen));
    const issues = await c.search("assignee = currentUser()");
    expect(issues).toEqual([{ key: "KAN-1", summary: "s", status: "In Progress", issuetype: "Task", assignee: "Ada", parent: null, updated: "2026-08-24" }]);
    expect(seen[0]!.auth).toBe("Basic " + Buffer.from("a@b.c:tok").toString("base64"));
    expect(seen[0]!.url).toContain("jql=");
  });
  test("search tolerates missing fields and an empty result", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": {} }));
    expect(await c.search("x")).toEqual([]);
    const c2 = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": { issues: [{ key: "K", fields: {} }] } }));
    expect((await c2.search("x"))[0]).toMatchObject({ key: "K", summary: "", assignee: null });
  });
  test("links reads both directions", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/issue/KAN-1": { fields: { issuelinks: [
      { type: { name: "Blocks" }, outwardIssue: { key: "KAN-2" } },
      { type: { name: "Relates" }, inwardIssue: { key: "KAN-3" } },
      { type: { name: "x" } },
    ] } } }));
    expect(await c.links("KAN-1")).toEqual([
      { type: "Blocks", direction: "outward", key: "KAN-2" },
      { type: "Relates", direction: "inward", key: "KAN-3" },
    ]);
  });
  test("a non-2xx response throws with the status", async () => {
    const c = new AtlassianClient("https://x", "a", "t", async () => new Response("nope", { status: 401 }));
    await expect(c.search("x")).rejects.toThrow(/401/);
  });

  test("comments() maps id/body/created off a faked fetch, flattening ADF bodies", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/issue/KAN-1/comment": {
        comments: [
          { id: "10", created: "2026-08-28T00:00:00.000Z", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] } },
          { id: "9", created: "2026-08-27T00:00:00.000Z", body: { type: "doc", content: [] } },
        ],
      },
    }));
    expect(await c.comments("KAN-1")).toEqual([
      { id: "10", body: "Looks good", created: "2026-08-28T00:00:00.000Z" },
      { id: "9", body: "", created: "2026-08-27T00:00:00.000Z" },
    ]);
  });
});

describe("adfToText", () => {
  test("flattens a nested fixture: paragraph, bullet list, hardBreak", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item two" }] }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }] },
      ],
    };
    expect(adfToText(doc)).toBe("Hello world\nItem one\nItem two\nLine one\nLine two");
  });
  test("tolerates a missing/empty body", () => {
    expect(adfToText(undefined)).toBe("");
    expect(adfToText(null)).toBe("");
    expect(adfToText({ type: "doc" })).toBe("");
  });
});
