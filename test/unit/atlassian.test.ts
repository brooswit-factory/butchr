import { describe, expect, test } from "bun:test";
import { AtlassianClient, AtlassianHttpError, adfToText } from "../../src/atlassian/client.js";

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
    expect(issues).toEqual([{ key: "KAN-1", summary: "s", status: "In Progress", issuetype: "Task", assignee: "Ada", parent: null, updated: "2026-08-24", labels: [] }]);
    expect(seen[0]!.auth).toBe("Basic " + Buffer.from("a@b.c:tok").toString("base64"));
    expect(seen[0]!.url).toContain("jql=");
  });
  test("search tolerates missing fields and an empty result", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": {} }));
    expect(await c.search("x")).toEqual([]);
    const c2 = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": { issues: [{ key: "K", fields: {} }] } }));
    expect((await c2.search("x"))[0]).toMatchObject({ key: "K", summary: "", assignee: null });
  });
  // BUTCHR-169: ISSUE_SPAWN_CONFIG.specFor (src/resources/issue.ts) derives a
  // spawned ticket's boss from issuelinks on the SEARCH result — this is the
  // batching that makes that possible without a second, per-issue API call
  // on every poll. If "issuelinks" ever silently drops out of this fields
  // param, specFor's parent derivation goes quietly back to always-null,
  // exactly the defect BUTCHR-169 fixed — this guard is what would catch
  // that regression.
  test("search requests issuelinks in fields, so a boss can be derived without a second call", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": { issues: [] } }, seen));
    await c.search("x");
    expect(seen[0]!.url).toContain("issuelinks");
  });
  test("search maps issuelinks using the SAME direction convention as links() — same parser, one place to be right", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/search/jql": { issues: [{ key: "KAN-757", fields: { summary: "s", issuelinks: [{ id: "10595", type: { name: "Implements" }, inwardIssue: { key: "KAN-759" } }] } }] },
    }));
    const issues = await c.search("x");
    expect(issues[0]!.issuelinks).toEqual([{ type: "Implements", otherEnd: "inward", key: "KAN-759" }]);
  });
  test("search leaves issuelinks UNDEFINED (never a fabricated []) when the response omits the field entirely — 'unknown', not 'confirmed none'", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/search/jql": { issues: [{ key: "K", fields: { summary: "s" } }] } }));
    const issues = await c.search("x");
    expect("issuelinks" in issues[0]!).toBe(false);
  });
  test("links reads both directions", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/issue/KAN-1": { fields: { issuelinks: [
      { type: { name: "Blocks" }, outwardIssue: { key: "KAN-2" } },
      { type: { name: "Relates" }, inwardIssue: { key: "KAN-3" } },
      { type: { name: "x" } },
    ] } } }));
    expect(await c.links("KAN-1")).toEqual([
      { type: "Blocks", otherEnd: "outward", key: "KAN-2" },
      { type: "Relates", otherEnd: "inward", key: "KAN-3" },
    ]);
  });

  // Real-payload fixtures for BOTH ends of ONE Implements link (link id 10595,
  // created by jira_link_issues(from=KAN-757, to=KAN-759), i.e. KAN-757
  // implements KAN-759): on the boss (KAN-759), the implementer appears as
  // outwardIssue; on the implementer (KAN-757), the boss appears as
  // inwardIssue. This pins the DIRECTION CONTRACT from src/atlassian/types.ts.
  test("links maps the boss's view of an Implements link: the implementer is otherEnd 'outward'", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/issue/KAN-759": { fields: { issuelinks: [
      { id: "10595", type: { name: "Implements" }, outwardIssue: { key: "KAN-757" } },
    ] } } }));
    expect(await c.links("KAN-759")).toEqual([{ type: "Implements", otherEnd: "outward", key: "KAN-757" }]);
  });
  test("links maps the implementer's view of an Implements link: the boss is otherEnd 'inward'", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({ "/issue/KAN-757": { fields: { issuelinks: [
      { id: "10595", type: { name: "Implements" }, inwardIssue: { key: "KAN-759" } },
    ] } } }));
    expect(await c.links("KAN-757")).toEqual([{ type: "Implements", otherEnd: "inward", key: "KAN-759" }]);
  });
  test("a non-2xx response throws with the status", async () => {
    const c = new AtlassianClient("https://x", "a", "t", async () => new Response("nope", { status: 401 }));
    await expect(c.search("x")).rejects.toThrow(/401/);
  });

  test("updateLabels sends add/remove ops in one PUT request, never a wholesale field set", async () => {
    const seen: { url: string; method: string | undefined; body: string | undefined }[] = [];
    const c = new AtlassianClient("https://x.atlassian.net", "a@b.c", "tok", async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body as string | undefined });
      return new Response("", { status: 204 });
    });
    await c.updateLabels("KAN-1", { add: ["agent:idle"], remove: ["agent:working"] });
    expect(seen.length).toBe(1);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toContain("/rest/api/3/issue/KAN-1?notifyUsers=false");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ update: { labels: [{ add: "agent:idle" }, { remove: "agent:working" }] } });
  });

  test("updateLabels is a no-op (no request) when there is nothing to add or remove", async () => {
    let called = false;
    const c = new AtlassianClient("https://x", "a", "t", async () => { called = true; return new Response("", { status: 204 }); });
    await c.updateLabels("KAN-1", {});
    expect(called).toBe(false);
  });

  test("updateLabels throws with the status on a non-2xx response", async () => {
    const c = new AtlassianClient("https://x", "a", "t", async () => new Response("nope", { status: 400 }));
    await expect(c.updateLabels("KAN-1", { add: ["agent:idle"] })).rejects.toThrow(/400/);
  });

  test("updateLabels defaults to a quiet write (notifyUsers=false)", async () => {
    const seen: string[] = [];
    const c = new AtlassianClient("https://x", "a", "t", async (url) => { seen.push(url); return new Response("", { status: 204 }); });
    await c.updateLabels("KAN-1", { add: ["agent:idle"] });
    expect(seen[0]).toContain("notifyUsers=false");
  });

  test("updateLabels sends a notifying write (no notifyUsers param) when told to", async () => {
    const seen: string[] = [];
    const c = new AtlassianClient("https://x", "a", "t", async (url) => { seen.push(url); return new Response("", { status: 204 }); });
    await c.updateLabels("KAN-1", { add: ["agent:idle"] }, { notify: true });
    expect(seen[0]).not.toContain("notifyUsers");
  });

  test("a failed updateLabels rejects with an AtlassianHttpError naming method, path, and status", async () => {
    const c = new AtlassianClient("https://x", "a", "t", async () => new Response("forbidden", { status: 403 }));
    const err = await c.updateLabels("KAN-1", { add: ["agent:idle"] }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlassianHttpError);
    expect((err as AtlassianHttpError).status).toBe(403);
    expect((err as Error).message).toContain("PUT");
    expect((err as Error).message).toContain("/rest/api/3/issue/KAN-1");
  });

  test("canSuppressNotifications is true when ADMINISTER_PROJECTS is held", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/mypermissions": { permissions: { ADMINISTER_PROJECTS: { havePermission: true }, ADMINISTER: { havePermission: false } } },
    }));
    expect(await c.canSuppressNotifications("KAN")).toBe(true);
  });

  test("canSuppressNotifications is true when only global ADMINISTER is held", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/mypermissions": { permissions: { ADMINISTER: { havePermission: true } } },
    }));
    expect(await c.canSuppressNotifications("KAN")).toBe(true);
  });

  test("canSuppressNotifications is false when neither permission is held", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/mypermissions": { permissions: { ADMINISTER_PROJECTS: { havePermission: false }, ADMINISTER: { havePermission: false } } },
    }));
    expect(await c.canSuppressNotifications("KAN")).toBe(false);
  });

  test("canSuppressNotifications never throws: an erroring request degrades to false and logs once, naming the project", async () => {
    const logs: string[] = [];
    const c = new AtlassianClient("https://x", "a", "t", async () => new Response("nope", { status: 500 }), (line) => logs.push(line));
    expect(await c.canSuppressNotifications("KAN")).toBe(false);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("KAN");
  });

  test("comments() maps id/body/created/authorEmail off a faked fetch, flattening ADF bodies", async () => {
    const c = new AtlassianClient("https://x", "a", "t", fakeFetch({
      "/issue/KAN-1/comment": {
        comments: [
          { id: "10", created: "2026-08-28T00:00:00.000Z", author: { emailAddress: "agent@example.com" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] } },
          { id: "9", created: "2026-08-27T00:00:00.000Z", body: { type: "doc", content: [] } },
        ],
      },
    }));
    expect(await c.comments("KAN-1")).toEqual([
      { id: "10", body: "Looks good", created: "2026-08-28T00:00:00.000Z", authorEmail: "agent@example.com" },
      { id: "9", body: "", created: "2026-08-27T00:00:00.000Z", authorEmail: null },
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
