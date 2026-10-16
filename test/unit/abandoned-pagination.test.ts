import { expect, test } from "bun:test";
import { AtlassianClient } from "../../src/atlassian/client.js";
import { createTodoWorkersFetch, TODO_WORKER_JQL } from "../../src/resources/issue.js";
import { createAbandonedDetector } from "../../src/agents/abandoned.js";

// Exercise the actual HTTP pagination adapter through the detector, not a
// preassembled >100-item array that would also pass with first-page search.
for (const failure of ["none", "http", "incomplete"] as const) {
  test(`To Do page two survives ${failure} and retains its observation clock`, async () => {
    let now = 0;
    let fail = false;
    const requests: URL[] = [];
    const posted: string[] = [];
    const client = new AtlassianClient("https://jira.invalid", "test", "test", async (url) => {
      const u = new URL(url);
      requests.push(u);
      if (!u.searchParams.has("nextPageToken")) {
        return Response.json({ issues: Array.from({ length: 100 }, (_, i) => ({
          key: `WORK-${i + 1}`, fields: { status: { name: "To Do" }, issuetype: { name: "Task" } },
        })), nextPageToken: "page-two", isLast: false });
      }
      if (fail && failure === "http") return new Response("unavailable", { status: 503 });
      if (fail && failure === "incomplete") return Response.json({ issues: [], isLast: false });
      return Response.json({ issues: [{ key: "WORK-101", fields: {
        status: { name: "To Do" }, issuetype: { name: "Task" },
        issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "BOSS-1", fields: { status: { name: "Done" } } } }],
      } }], isLast: true });
    });
    const detector = createAbandonedDetector({
      now: () => now, minutes: 30,
      todoWorkers: createTodoWorkersFetch(client),
      comments: async () => [], links: async () => [],
      addComment: async (key) => { posted.push(key); },
    });
    await detector.check([]);
    now = 20 * 60_000;
    fail = failure !== "none";
    await detector.check([]);
    expect(posted).toEqual([]);
    fail = false;
    now = 30 * 60_000;
    await detector.check([]);
    expect(posted).toEqual(["WORK-101"]);
    expect(requests.length).toBe(6);
    expect(requests.every(u => u.searchParams.get("jql") === TODO_WORKER_JQL)).toBe(true);
    expect(requests[0]!.searchParams.get("maxResults")).toBe("100");
    expect(requests[1]!.searchParams.get("nextPageToken")).toBe("page-two");
  });
}
