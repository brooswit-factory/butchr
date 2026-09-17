import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection } from "@brooswit/thatch/testing";
import type { ToolDef } from "@brooswit/thatch";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { Herd } from "../../src/agents/herd.js";
import { agentLaunchConfig } from "../../src/agents/argv.js";
import { changeNudge, githubIssueNudge } from "../../src/agents/change-nudge.js";
import { buildWorkspace, GITHUB_ISSUE_TOOLS_NOTE, mcpIdentityHeaders, type SpawnSpec } from "../../src/agents/workspace.js";
import { buildApp } from "../../src/daemon/app.js";
import { startGithubIssueLoop } from "../../src/daemon/github-issue-loop.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import { createOwnWriteLedger } from "../../src/jira-watch/own-writes.js";
import { startBridge } from "../../src/mcp/bridge.js";
import { callerIdentity } from "../../src/mcp/identity.js";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";
import { createGithubIssueClient, type GithubIssue } from "../../src/resources/github-issue.js";
import { parseGithubIssueRef } from "../../src/resources/github-issue-ref.js";
import { githubIssueStaffing } from "../../src/rules/github-issue-type.js";
import { createRuleResourceType, ownsRuleAgent } from "../../src/rules/resource-type.js";
import { parseRules } from "../../src/rules/rules.js";
import { forJiraCallers, githubCommentTag, githubIssueTools } from "../../src/tools/github-issue.js";
import { Refusal } from "../../src/tools/outcome.js";

const GH = "github-issue:bugs:acme%2Fw%2312";
const JIRA = "jira-work:task:BUTCHR-1";
const ghCaller = { headers: { "x-butchr-agent": GH } };
const jiraCaller = { headers: { "x-issue": "BUTCHR-1", "x-butchr-agent": JIRA } };

const rules = parseRules({ rules: [
  { id: "task", resourceProvider: "jira-work", query: "type = Task", brief: "do it" },
  { id: "bugs", resourceProvider: "github-issue", query: "type:Bug repo:acme/w", brief: "fix it" },
] });

const gi = (ref: string, over: Partial<GithubIssue> = {}): GithubIssue => {
  const r = parseGithubIssueRef(ref)!;
  return { ref, owner: r.owner, repo: r.repo, number: r.number, title: "t", body: "b", state: "open", stateReason: null, issueType: "Bug", labels: [], comments: 0, updated: "u0", url: "x", ...over };
};
const jiraIssue = (key: string): JiraIssue =>
  ({ key, status: "In Progress", summary: `summary of ${key}`, issuetype: "Task", assignee: "me", parent: null, updated: "2026-09-16T00:00:00.000+0000", labels: [] });

const apiIssue = (owner: string, repo: string, number: number, over: Record<string, unknown> = {}) => ({
  number, title: "Crash on save", body: "steps…", state: "open", state_reason: null, type: { name: "Bug" }, labels: [], comments: 1,
  updated_at: "u1", html_url: `https://github.com/${owner}/${repo}/issues/${number}`, repository_url: `https://api.github.com/repos/${owner}/${repo}`, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake GitHub API: records every request, answers issue reads from `issues`, accepts comment POSTs. */
function fakeGithub(issues: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const path = new URL(url).pathname;
    if (method === "POST") return json({ id: 77, user: { login: "bot" }, body: JSON.parse(init!.body as string).body, created_at: "c", updated_at: "c" }, 201);
    if (path.endsWith("/comments")) return json([{ id: 5, user: { login: "alice" }, body: "any update?", created_at: "c", updated_at: "c" }]);
    return path in issues ? json(issues[path]) : json({}, 404);
  };
  return { calls, client: createGithubIssueClient({ fetchImpl, token: "tok", orgs: ["acme"] }) };
}

const call = (tools: Record<string, ToolDef<any>>, name: string, args: unknown, c: { headers: Record<string, string> }) =>
  Promise.resolve().then(() => tools[name]!.handler(args as never, c as never));

function fakeHerd(initial: string[] = []) {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [], nudged: string[] = [];
  const herd: Herd = {
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge(i) { nudged.push(i); return { delivered: true }; },
  };
  return { herd, spawned, stopped, nudged, running };
}
const tick = () => new Promise((r) => setTimeout(r, 40));

describe("provider-aware MCP identity", () => {
  test("callerIdentity: Jira callers unchanged; a GitHub agent is its key alone; mixed or malformed identities are nobody", () => {
    expect(callerIdentity({ "x-issue": "BUTCHR-1" })).toEqual({ provider: "jira-work", issue: "BUTCHR-1" });
    expect(callerIdentity(jiraCaller.headers)).toEqual({ provider: "jira-work", issue: "BUTCHR-1", agent: JIRA });
    expect(callerIdentity(ghCaller.headers)).toEqual({ provider: "github-issue", agent: GH, ruleId: "bugs", resource: "acme/w#12", ref: { owner: "acme", repo: "w", number: 12 } });
    expect(callerIdentity({ "x-issue": "BUTCHR-1", "x-butchr-agent": GH })).toBeNull();
    expect(callerIdentity({ "x-butchr-agent": JIRA })).toBeNull();
    expect(callerIdentity({ "x-butchr-agent": "github-issue:bugs:ACME%2Fw%2312" })).toBeNull();
    expect(callerIdentity({})).toBeNull();
  });

  const ghSpec: SpawnSpec = { key: GH, resource: "acme/w#12", issuetype: "bug", summary: "Crash on save", parent: null, brief: "fix it" };
  const jiraSpec: SpawnSpec = { key: JIRA, resource: "BUTCHR-1", issuetype: "task", summary: "s", parent: null, brief: "do it" };
  let root: string;
  const prev = process.env.BUTCHR_WORKSPACES;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "butchr-gh-agents-")); process.env.BUTCHR_WORKSPACES = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); if (prev === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = prev; });

  test("launch headers: GitHub agents send no x-issue; Jira agents are unchanged", () => {
    expect(mcpIdentityHeaders(ghSpec)).toEqual({ "x-butchr-agent": GH });
    expect(mcpIdentityHeaders(jiraSpec)).toEqual({ "x-issue": "BUTCHR-1", "x-butchr-agent": JIRA });
    const codex = agentLaunchConfig(ghSpec, "/d", "p", "n", { provider: "codex", disabledMcpServers: [] });
    expect(codex.provider === "codex" && codex.mcpServers[0]!.headers).toEqual({ "x-butchr-agent": GH, "x-butchr-provider": "codex" });
  });

  test("a claude GitHub workspace names its tools; a Jira brief does not", () => {
    const dir = buildWorkspace(ghSpec, "http://localhost:7717/mcp", "claude");
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.butchr.headers).toEqual({ "x-butchr-agent": GH });
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe(`# bugs agent — acme/w#12: Crash on save\n\n${GITHUB_ISSUE_TOOLS_NOTE}\n\nfix it\n`);
    const jiraDir = buildWorkspace(jiraSpec, "http://localhost:7717/mcp", "claude");
    expect(readFileSync(join(jiraDir, "brief.md"), "utf8")).toBe("# task agent — BUTCHR-1: s\n\ndo it\n");
  });

  test("the AGY bridge carries a GitHub agent key without x-issue, and refuses mismatched metadata", async () => {
    const dir = buildWorkspace(ghSpec, "http://localhost:7717/mcp", "agy");
    expect(bridgeWorkspace(root, dir)).toEqual({ url: new URL("http://localhost:7717/mcp"), agent: GH });
    const meta = join(dir, ".butchr-agy.json");
    for (const bad of [
      { agent: GH, resource: "acme/w#13", mcpUrl: "http://localhost:7717/mcp" },
      { agent: "github-issue:other:acme%2Fw%2312", resource: "acme/w#12", mcpUrl: "http://localhost:7717/mcp" },
      { issue: "acme/w#12", agent: GH, resource: "acme/w#12", mcpUrl: "http://localhost:7717/mcp" },
      { agent: GH, resource: "acme/w#12", mcpUrl: "file:///x" },
      { agent: GH, resource: "acme/w#12" },
    ]) {
      writeFileSync(meta, JSON.stringify(bad));
      expect(() => bridgeWorkspace(root, dir)).toThrow();
    }
    await expect(startBridge(new URL("http://127.0.0.1:1/mcp"), undefined)).rejects.toThrow("issue identity");
    await expect(startBridge(new URL("http://127.0.0.1:1/mcp"), undefined, { agent: JIRA })).rejects.toThrow("issue identity");
  });
});

describe("the MCP auth gate", () => {
  const view = {
    state: async () => [], open: async () => ({ ok: true }), openPane: async () => ({ ok: true }),
    health: () => ({ ok: true, components: [] }),
    dashboard: async () => ({ checked: true as const, confirmedAt: "", rows: [], admission: { cap: 0, residency: null, sources: [] } }),
    header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "t", version: "0" } }),
    resourceLink: async () => ({ ok: true as const, url: "x" }),
  };
  const { app, mcp } = buildApp(view as never, {}, () => {});
  app.listen(0);
  const base = `http://localhost:${app.server!.port}`;
  afterAll(async () => { await mcp.closeAll(); app.stop(); });

  test("admits a GitHub agent by key and a Jira agent as before; refuses a mixed or bare connection", async () => {
    const gh = await FakeConnection.connect(base, { headers: { "x-butchr-agent": GH } });
    const jira = await FakeConnection.connect(base, { headers: jiraCaller.headers });
    await expect(FakeConnection.connect(base, { headers: { "x-issue": "BUTCHR-1", "x-butchr-agent": GH } })).rejects.toThrow();
    await expect(FakeConnection.connect(base, { headers: { "x-butchr-agent": JIRA } })).rejects.toThrow();
    await gh.disconnect(); await jira.disconnect();
  });
});

describe("github issue tools", () => {
  const issues = {
    "/repos/acme/w/issues/12": apiIssue("acme", "w", 12),
    "/repos/acme/w/issues/13": apiIssue("acme", "w", 13, { pull_request: { url: "x" } }),
    "/repos/acme/w/issues/14": apiIssue("acme", "other", 14),
  };

  test("github_get_issue reads the caller's own issue: title, body, type and comments", async () => {
    const { client, calls } = fakeGithub(issues);
    const tools = githubIssueTools({ client, log: () => {} });
    expect(Object.keys(tools[`github_get_issue`]!.input)).toEqual([]);
    expect(await call(tools, "github_get_issue", {}, ghCaller)).toMatchObject({
      issue: "acme/w#12", title: "Crash on save", body: "steps…", type: "Bug", state: "open",
      comments: [{ id: "5", author: "alice", body: "any update?", created: "c", updated: "c" }],
    });
    expect(calls.every((c) => c.method === "GET" && c.url.includes("/repos/acme/w/issues/12"))).toBe(true);
  });

  test("github_add_comment tags and posts to the caller's own issue only, and records the write for echo suppression", async () => {
    const { client, calls } = fakeGithub(issues);
    const writes: string[][] = [];
    const tools = githubIssueTools({ client, onWrite: (r, u, w) => writes.push([r, u, w]), log: () => {} });
    expect(await call(tools, "github_add_comment", { text: "Fixed in main." }, ghCaller)).toEqual({ ok: true, issue: "acme/w#12", comment: "77" });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ method: "POST", url: "https://api.github.com/repos/acme/w/issues/12/comments", body: JSON.stringify({ body: `${githubCommentTag("bugs")} Fixed in main.` }) }]);
    expect(writes).toEqual([["acme/w#12", "u1", GH]]);
  });

  test("no cross-provider calls: Jira callers are refused GitHub tools, and GitHub agents never reach a Jira tool", async () => {
    const { client, calls } = fakeGithub(issues);
    const tools = githubIssueTools({ client, log: () => {} });
    for (const c of [jiraCaller, { headers: { "x-issue": "BUTCHR-1" } }, { headers: {} }]) {
      await expect(call(tools, "github_add_comment", { text: "x" }, c)).rejects.toBeInstanceOf(Refusal);
      await expect(call(tools, "github_get_issue", {}, c)).rejects.toBeInstanceOf(Refusal);
    }
    expect(calls).toEqual([]);

    const jiraCalls: unknown[] = [];
    const jira = forJiraCallers({ jira_add_comment: { description: "d", input: {}, handler: (a) => { jiraCalls.push(a); return "ok"; } } }, () => {});
    await expect(call(jira, "jira_add_comment", { key: "BUTCHR-1", text: "x" }, ghCaller)).rejects.toThrow("refusing a github-issue agent");
    expect(jiraCalls).toEqual([]);
    expect(await call(jira, "jira_add_comment", { key: "BUTCHR-1" }, jiraCaller)).toBe("ok");
    expect(jiraCalls).toEqual([{ key: "BUTCHR-1" }]);
  });

  test("pull requests, transferred issues and other orgs are never read or written as the caller's issue", async () => {
    const { client, calls } = fakeGithub(issues);
    const tools = githubIssueTools({ client, log: () => {} });
    const as = (ref: string) => ({ headers: { "x-butchr-agent": `github-issue:bugs:${encodeURIComponent(ref)}` } });
    await expect(call(tools, "github_add_comment", { text: "x" }, as("acme/w#13"))).rejects.toThrow("pull request");
    await expect(call(tools, "github_get_issue", {}, as("acme/w#13"))).rejects.toThrow("pull request");
    await expect(call(tools, "github_add_comment", { text: "x" }, as("acme/w#14"))).rejects.toThrow("transferred");
    await expect(call(tools, "github_add_comment", { text: "x" }, as("evil/w#1"))).rejects.toThrow("outside BUTCHR_GITHUB_ORGS");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(calls.some((c) => c.url.includes("/repos/evil/"))).toBe(false);
    const failing = createGithubIssueClient({ token: "t", orgs: ["acme"], fetchImpl: async (_u, init) => (init?.method === "POST" ? json({}, 403) : json(apiIssue("acme", "w", 12))) });
    await expect(failing.addComment({ owner: "acme", repo: "w", number: 12 }, "x")).rejects.toThrow("HTTP 403");
    const odd = createGithubIssueClient({ token: "t", orgs: ["acme"], fetchImpl: async () => json(null) });
    await expect(odd.get({ owner: "acme", repo: "w", number: 12 })).rejects.toThrow("unexpected body");
  });

  test("a failed own-write read-back is logged, never a tool error", async () => {
    let gets = 0;
    const client = createGithubIssueClient({ token: "t", orgs: ["acme"], fetchImpl: async (_u, init) => {
      if (init?.method === "POST") return json({ id: 1 }, 201);
      return ++gets === 1 ? json(apiIssue("acme", "w", 12)) : json({}, 500);
    } });
    const logs: string[] = [];
    const tools = githubIssueTools({ client, onWrite: () => { throw new Error("unreached"); }, log: (l) => logs.push(l) });
    expect(await call(tools, "github_add_comment", { text: `${githubCommentTag("bugs")} already tagged` }, ghCaller)).toMatchObject({ ok: true });
    expect(logs.some((l) => l.includes("own-write read-back failed"))).toBe(true);
  });
});

describe("startup gating", () => {
  const onlyJira = parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "b" }] });

  test("github-issue rules run only with auth, scope, and queries inside that scope", () => {
    expect(githubIssueStaffing(onlyJira, undefined)).toEqual({ run: false, rules: [], reason: null });
    expect(githubIssueStaffing(rules, undefined)).toMatchObject({ run: false, reason: expect.stringContaining("set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS") });
    expect(githubIssueStaffing(rules, { token: "", orgs: ["acme"] })).toMatchObject({ run: false });
    expect(githubIssueStaffing(rules, { token: "t", orgs: [] })).toMatchObject({ run: false });
    expect(githubIssueStaffing(rules, { token: "t", orgs: ["beta"] })).toMatchObject({ run: false, reason: expect.stringContaining("bugs: github-issue query names repo:acme/w outside BUTCHR_GITHUB_ORGS") });
    const ok = githubIssueStaffing(rules, { token: "t", orgs: ["acme"] });
    expect(ok.run).toBe(true);
    expect(ok.rules.map((r) => r.id)).toEqual(["bugs"]);
  });

  test("a closed gate starts no loop, searches nothing and spawns nothing", async () => {
    const { herd, spawned } = fakeHerd();
    let searched = 0;
    const logs: string[] = [];
    const stop = startGithubIssueLoop({
      staffing: githubIssueStaffing(rules, undefined),
      client: { searchAll: async () => { searched++; return [gi("acme/w#12")]; }, comments: async () => [] },
      herd, deliver: async () => {}, log: (l) => logs.push(l), intervalMs: 5,
    });
    await tick();
    expect(stop).toBeNull();
    expect([searched, spawned]).toEqual([0, []]);
    expect(logs).toEqual([expect.stringContaining("WARNING: github-issue rules not staffed (bugs)")]);
    expect(startGithubIssueLoop({ staffing: githubIssueStaffing(onlyJira, undefined), client: { searchAll: async () => [], comments: async () => [] }, herd, deliver: async () => {}, log: (l) => logs.push(l) })).toBeNull();
    expect(logs.length).toBe(1);
  });
});

describe("two resource types in one daemon", () => {
  test("each loop staffs, stops and notifies only its own agents; a GitHub agent's own comment is not echoed back", async () => {
    const { herd, spawned, stopped, running } = fakeHerd(["BUTCHR-9"]);
    let ghIssues = [gi("acme/w#12")];
    let jiraIssues = [jiraIssue("BUTCHR-1")];
    const delivered: Array<[string, string, string]> = [];
    const jiraNotified: string[] = [];
    const ledger = createOwnWriteLedger();
    const logs: string[] = [];

    const stopJira = runResourceLoop(createRuleResourceType({ rules, search: async () => jiraIssues }), {
      herd, ownsId: ownsRuleAgent, intervalMs: 10, notify: (agent) => { jiraNotified.push(agent); },
    });
    const stopGithub = startGithubIssueLoop({
      staffing: githubIssueStaffing(rules, { token: "t", orgs: ["acme"] }),
      client: { searchAll: async () => ghIssues, comments: async () => [{ id: "c9", author: "alice", body: "ping", created: "", updated: "" }] },
      herd,
      deliver: async (agent, resource, msg) => { delivered.push([agent, resource, msg]); },
      suppress: (resource, updated, watcher) => ledger.shouldSuppress(resource, updated, watcher, Date.now()),
      log: (l) => logs.push(l),
      intervalMs: 10,
    })!;
    await tick();
    expect(new Set(spawned)).toEqual(new Set([JIRA, GH]));

    // The agent's own comment (recorded as a write at its read-back `updated`) notifies nobody.
    ledger.record("acme/w#12", "u1", GH, Date.now());
    ghIssues = [gi("acme/w#12", { comments: 1, updated: "u1" })];
    await tick();
    expect(delivered).toEqual([]);

    // Someone else's comment reaches exactly the GitHub agent, naming its tool — never the Jira agent.
    ghIssues = [gi("acme/w#12", { comments: 2, updated: "u2" })];
    await tick();
    expect(delivered).toEqual([[GH, "acme/w#12", "[butchr] GitHub issue acme/w#12 got a new comment — re-read it with github_get_issue."]]);
    expect(jiraNotified).toEqual([]);

    // The Jira ticket leaving its query stops only the Jira agent, and vice versa; the legacy agent is never touched.
    jiraIssues = [];
    await tick();
    expect(stopped).toEqual([JIRA]);
    ghIssues = [];
    await tick();
    stopJira(); stopGithub();
    expect(stopped).toEqual([JIRA, GH]);
    expect([...running]).toEqual(["BUTCHR-9"]);
    expect(logs.filter((l) => l.includes("loop error"))).toEqual([]);
  });

  test("nudges: GitHub text names github_get_issue; Jira text is unchanged", () => {
    expect(githubIssueNudge("acme/w#1", { summary: true })).toBe("[butchr] GitHub issue acme/w#1 had its title edited — re-read it with github_get_issue.");
    expect(githubIssueNudge("acme/w#1", { status: { from: "open", to: "closed" } })).toBe('[butchr] GitHub issue acme/w#1 changed status from "open" to "closed" — re-read it with github_get_issue.');
    expect(changeNudge("BUTCHR-1", "BUTCHR-1", { summary: true })).toBe("[butchr] Ticket BUTCHR-1 had its summary edited — re-read it.");
  });
});
