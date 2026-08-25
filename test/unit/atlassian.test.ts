import { describe, expect, test } from "bun:test";
import { AtlassianClient } from "../../src/atlassian/client.js";

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
});
