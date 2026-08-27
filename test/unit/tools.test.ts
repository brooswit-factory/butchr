import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

function rig() {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve({ ok: name }); };
  const ops: AtlassianOps = {
    getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"),
    transition: rec("transition"), createIssue: rec("createIssue"),
    createPage: rec("createPage"), getPage: rec("getPage"), listSpaces: rec("listSpaces"),
  };
  const audits: string[] = [];
  const tools = atlassianTools(ops, (l) => audits.push(l));
  const conn = { headers: { "x-issue": "KAN-7" } } as any;
  return { tools, calls, audits, conn };
}

describe("atlassianTools", () => {
  test("exposes the full proxy surface", () => {
    const { tools } = rig();
    expect(Object.keys(tools).sort()).toEqual([
      "confluence_create_page", "confluence_get_page", "confluence_list_spaces",
      "jira_add_comment", "jira_create_issue", "jira_get_issue", "jira_link_issues", "jira_search", "jira_transition",
    ]);
  });
  test("each tool routes to its op and audits the caller's issue", async () => {
    const { tools, calls, audits, conn } = rig();
    await tools.jira_get_issue!.handler({ key: "KAN-1" }, conn);
    await tools.jira_search!.handler({ jql: "project = KAN", maxResults: 5 }, conn);
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "hi" }, conn);
    await tools.jira_transition!.handler({ key: "KAN-1", status: "In Review" }, conn);
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", parent: "KAN-2", assignee: "acct-1" }, conn);
    await tools.jira_link_issues!.handler({ from: "KAN-2", to: "KAN-9" }, conn);
    await tools.confluence_create_page!.handler({ spaceId: "1", title: "t", body: "<p/>" }, conn);
    await tools.confluence_get_page!.handler({ id: "9" }, conn);
    await tools.confluence_list_spaces!.handler({}, conn);
    expect(calls.map(([n]) => n)).toEqual(["getIssue", "search", "addComment", "transition", "createIssue", "linkIssues", "createPage", "getPage", "listSpaces"]);
    expect(calls[1]![1]).toEqual(["project = KAN", 5]);
    expect((calls[4]![1][0] as { assignee?: string }).assignee).toBe("acct-1");   // assignee reaches the op
    expect(calls[5]![0]).toBe("linkIssues");
    expect(calls[5]![1]).toEqual(["KAN-2", "KAN-9", "Relates"]);                  // default link type applied
    expect(audits.every((a) => a.includes("KAN-7"))).toBe(true);
    expect(audits.length).toBe(8);
  });
  test("search defaults maxResults when omitted", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_search!.handler({ jql: "x" }, conn);
    expect(calls[0]![1]).toEqual(["x", 25]);
  });
});
