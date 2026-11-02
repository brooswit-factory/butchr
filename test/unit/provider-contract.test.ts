import { describe, expect, test } from "bun:test";
import { providerAtlassianTools } from "../../src/tools/provider-atlassian.js";
import { githubPrTools } from "../../src/tools/github-pr.js";
import { githubIssueTools } from "../../src/tools/github-issue.js";
import { jiraIdeaTools } from "../../src/tools/jira-idea.js";
import { zendeskTicketTools } from "../../src/tools/zendesk-ticket.js";
import { createGithubPrClient } from "../../src/resources/github-pr.js";
import { createZendeskTicketClient } from "../../src/resources/zendesk-ticket.js";
import { providerTarget } from "../../src/tools/provider-target.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

const task = { headers: { "x-issue": "WORK-1", "x-butchr-agent": "jira-work:tasks:WORK-1" } };
const manager = { headers: { "x-butchr-agent": "jira-project:managers:WORK" } };
const query = { headers: { "x-butchr-agent": "jira-project:managers:%40query" } };
const silent = () => {};
const call = (tools: any, name: string, args: any, caller: { headers: Record<string, string> } = task): Promise<any> => Promise.resolve().then(() => tools[name].handler(args, caller));
function fakeOps() {
  const calls: Array<{ method: string; args: any[] }> = [];
  const ops = new Proxy({}, { get: (_, method: string) => async (...args: any[]) => {
    calls.push({ method, args });
    if (method === "createIssue") return { key: "WORK-99" };
    if (method === "getIssue") return { key: args[0], fields: { issuetype: { name: args[0] === "WORK-3" ? "Epic" : "Task" } } };
    return undefined;
  } }) as AtlassianOps;
  return { ops, calls };
}

describe("role-independent provider contract", () => {
  test("tasks can read and edit other tasks and epics without an ownership lookup", async () => {
    const { ops, calls } = fakeOps(); const tools = providerAtlassianTools(ops, silent);
    for (const key of ["WORK-2", "WORK-3"]) {
      expect((await call(tools, "jira_get_issue", { key })).key).toBe(key);
      await call(tools, "jira_update_issue", { key, summary: "Updated", description: "" });
      await call(tools, "jira_transition", { key, status: "Done" });
      await call(tools, "jira_assign", { key, assignee: "account-123" });
      await call(tools, "jira_set_priority", { key, priority: "High" });
    }
    expect(calls.filter(c => c.method === "getIssue")).toHaveLength(2);
    expect(calls.filter(c => c.method === "correctText").map(c => c.args)).toEqual([
      ["WORK-2", { summary: "Updated", description: "" }], ["WORK-3", { summary: "Updated", description: "" }],
    ]);
    expect(tools.finish_worker).toBeUndefined();
    expect(tools.new_worker).toBeUndefined();
  });
  test("manager and query callers use explicit Jira and Confluence targets without scope rewriting", async () => {
    const { ops, calls } = fakeOps(); const tools = providerAtlassianTools(ops, silent);
    for (const caller of [manager, query]) {
      await call(tools, "jira_search", { jql: "project = OTHER" }, caller);
      await call(tools, "jira_get_issue", { key: "OTHER-2" }, caller);
      await call(tools, "confluence_get_page", { id: "123" }, caller);
      await call(tools, "jira_add_comment", { key: "OTHER-2", text: "Review findings" }, caller);
    }
    expect(calls[0]).toEqual({ method: "search", args: ["project = OTHER", 25] });
    expect(calls[3]!.args[1]).toContain("[jira-project:managers:WORK]");
  });
  test("creation uses explicit fields, any provider issue type and no staffing inference", async () => {
    const { ops, calls } = fakeOps(); const tools = providerAtlassianTools(ops, silent);
    expect(await call(tools, "jira_create_issue", { projectKey: "WORK", issuetype: "Bug", summary: "Problem" })).toEqual({ key: "WORK-99" });
    expect(calls).toEqual([{ method: "createIssue", args: [{ projectKey: "WORK", issuetype: "Bug", summary: "Problem" }] }]);
  });
  test("failed optional link preserves the successful create receipt; invalid input writes nothing", async () => {
    const { ops, calls } = fakeOps();
    const tools = providerAtlassianTools({ ...ops, createIssue: ops.createIssue, linkIssues: async () => { throw new Error("403 Forbidden"); } } as AtlassianOps, silent);
    expect(await call(tools, "jira_create_issue", { projectKey: "WORK", issuetype: "Task", summary: "Problem", implements: "WORK-3" })).toEqual({ key: "WORK-99", implements: { ok: false, to: "WORK-3", error: "403 Forbidden" } });
    await expect(call(tools, "jira_create_issue", { projectKey: "../bad", issuetype: "Task", summary: "Problem" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  test("provider denial propagates without a false success or own-write receipt", async () => {
    const writes: unknown[] = [];
    const tools = providerAtlassianTools({ transition: async () => { throw new Error("Atlassian 403"); } } as unknown as AtlassianOps, silent, (...args) => { writes.push(args); });
    await expect(call(tools, "jira_transition", { key: "OTHER-2", status: "Done" }, manager)).rejects.toThrow("Atlassian 403");
    expect(writes).toEqual([]);
  });
  test("explicit GitHub PR targets work for managers and query agents; account scope and HTTP denial remain", async () => {
    const requests: string[] = [];
    const client = createGithubPrClient({ token: "test-token", orgs: ["acme"], fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
    } });
    const tools = githubPrTools({ client, log: silent });
    await expect(call(tools, "github_get_pr", { target: "acme/repo#2" }, manager)).rejects.toThrow("403");
    const before = requests.length;
    await expect(call(tools, "github_get_pr", { target: "outside/repo#2" }, query)).rejects.toThrow("outside BUTCHR_GITHUB_ORGS");
    expect(requests.length).toBe(before);
    await expect(call(tools, "github_get_pr", { target: "https://evil.invalid" }, task)).rejects.toThrow("invalid");
    expect(requests.length).toBe(before);
  });
  test("explicit reads and comments use their target and preserve writer attribution", async () => {
    const written: any[] = [];
    const github = githubIssueTools({ client: { get: async () => ({ ref: "acme/repo#2", updated: "now" }) as any, comments: async () => [], addComment: async (ref, body) => { written.push([ref, body]); return { id: "1" } as any; } }, log: silent });
    expect(await call(github, "github_get_issue", { target: "acme/repo#2" }, manager)).toMatchObject({ issue: "acme/repo#2" });
    expect(await call(github, "github_add_comment", { target: "acme/repo#2", text: "Finding" }, manager)).toMatchObject({ issue: "acme/repo#2", comment: "1" });
    expect(written[0]).toEqual([{ owner: "acme", repo: "repo", number: 2 }, "[butchr managers] Finding"]);
    const ideas = jiraIdeaTools({ client: { get: async (key: string) => ({ key }), comments: async () => [] } as any, site: "https://example.atlassian.net", log: silent });
    expect(await call(ideas, "jira_idea_get", { target: "IDEA-2" }, task)).toMatchObject({ idea: "IDEA-2" });
  });
  test("Zendesk explicit targets retain account containment and truthful privacy receipts", async () => {
    let fetched = false;
    const client = createZendeskTicketClient({ subdomain: "acme", token: "test-token", fetchImpl: async () => { fetched = true; throw new Error("unexpected"); } });
    await expect(call(zendeskTicketTools({ client, log: silent }), "zendesk_get_ticket", { target: "outside#2" }, manager)).rejects.toThrow("outside ZENDESK_SUBDOMAIN");
    expect(fetched).toBe(false);
    const tools = zendeskTicketTools({ client: { addInternalNote: async () => ({ id: null, confirmedPrivate: false, updated: null }) } as any, log: silent });
    expect(await call(tools, "zendesk_add_internal_note", { target: "acme#2", text: "Finding" }, manager)).toMatchObject({ internal: null, confirmedPrivate: false });
  });
  test("explicit target beats the default and malformed targets never fall back", () => {
    const headers = { "x-butchr-agent": "jira-idea:ideas:IDEA-1" };
    expect(providerTarget(headers, "IDEA-2", "jira-idea", v => v, "read").resource).toBe("IDEA-2");
    expect(providerTarget(headers, undefined, "jira-idea", v => v, "read").resource).toBe("IDEA-1");
    expect(() => providerTarget(headers, "bad", "jira-idea", () => null, "read")).toThrow("invalid");
    expect(() => providerTarget({}, undefined, "jira-idea", v => v, "read")).toThrow("explicit target");
  });
});

test("explicit comment, document discovery and shelf operations preserve targets and provider denials", async () => {
  const { ops, calls } = fakeOps();
  const tools = providerAtlassianTools(ops, silent);
  for (const caller of [task, manager, query]) {
    await call(tools, "confluence_get_comments", { id: "123" }, caller);
    await call(tools, "confluence_add_comment", { id: "123", text: "<review>&" }, caller);
    await call(tools, "jira_get_project_property", { projectKey: "OTHER", propertyKey: "butchr" }, caller);
    await call(tools, "jira_get_remote_link", { key: "OTHER-2", globalId: "doc" }, caller);
    await call(tools, "jira_remove_labels", { key: "OTHER-2", labels: ["butchr:shelved"] }, caller);
    await call(tools, "jira_add_labels", { key: "OTHER-2", labels: ["butchr:shelved"] }, caller);
  }
  expect(calls[1]!.args).toEqual(["123", "<p>[jira-work:tasks:WORK-1] &lt;review&gt;&amp;</p>"]);
  expect(calls[4]!.args).toEqual(["OTHER-2", ["butchr:shelved"]]);
  expect(calls.filter(c => c.method === "transition")).toHaveLength(0);
  const denied = providerAtlassianTools({ getPageComments: async () => { throw new Error("403 Forbidden"); } } as unknown as AtlassianOps, silent);
  await expect(call(denied, "confluence_get_comments", { id: "123" }, query)).rejects.toThrow("403");
  await expect(call(tools, "confluence_get_comments", {}, manager)).rejects.toThrow();
});

test("Confluence bounded reads require stable versions and never expose partial content as body", async () => {
  const tools = providerAtlassianTools({ getPage: async () => ({ title: "Doc", version: { number: 3 }, body: { storage: { value: "abcdef" } } }) } as unknown as AtlassianOps, silent);
  const first = await call(tools, "confluence_read_document", { id: "123", limit: 3 });
  expect(first.chunk).toBe("abc");
  expect(first.body).toBeUndefined();
  expect(first.next.offset).toBe(3);
  await expect(call(tools, "confluence_read_document", { id: "123", offset: 3, limit: 3 })).rejects.toThrow();
  await expect(call(tools, "confluence_read_document", { id: "123", offset: 3, limit: 3, expectVersion: 2 })).rejects.toThrow();
  expect((await call(tools, "confluence_read_document", { id: "123", offset: 3, limit: 3, expectVersion: 3 })).chunk).toBe("def");
});

test("composed Confluence handlers emit exactly one outcome including validation and provider failures", async () => {
  const lines: string[] = [];
  const tools = providerAtlassianTools({ getPage: async (id: string) => { if (id === "denied") throw new Error("403"); return { id }; } } as unknown as AtlassianOps, line => lines.push(line));
  await call(tools, "confluence_get_page", { id: "123" });
  await expect(call(tools, "confluence_get_page", { id: "denied" })).rejects.toThrow("403");
  await expect(call(tools, "confluence_get_page", {})).rejects.toThrow();
  const outcomes = lines.filter(line => line.includes("[tools2]"));
  expect(outcomes).toHaveLength(3);
  expect(outcomes[0]).toContain("target=123");
  expect(outcomes[1]).toContain("outcome=error");
});
