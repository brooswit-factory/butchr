import { describe, expect, test } from "bun:test";
import type { ToolDef } from "@brooswit/thatch";
import { createGithubPrClient, type GithubPr } from "../../src/resources/github-pr.js";
import { parseGithubPrRef } from "../../src/resources/github-pr-ref.js";
import { forJiraCallers } from "../../src/tools/github-issue.js";
import { Refusal } from "../../src/tools/outcome.js";
import { githubPrCommentTag, githubPrTools } from "../../src/tools/github-pr.js";

/**
 * FACTORY-57: tool-handler-level coverage for `src/tools/github-pr.ts`,
 * mirroring `test/unit/zendesk-ticket.test.ts`'s "call tools directly, no
 * real HTTP bridge" convention (see that file's own `call` helper).
 */
const PR = "github-pr:prs:acme%2Fw%2312";
const ISSUE = "github-issue:bugs:acme%2Fw%2312";
const JIRA = "jira-work:task:BUTCHR-1";
const prCaller = { headers: { "x-butchr-agent": PR } };

const call = (tools: Record<string, ToolDef<any>>, name: string, args: unknown, c: { headers: Record<string, string> }) =>
  Promise.resolve().then(() => tools[name]!.handler(args as never, c as never));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { method: string; url: string; body?: string };

/** A fake GitHub API: records every request, answers PR/pulls reads from `prs`, accepts comment POSTs. */
function fakeGithub(prs: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "POST" && url.endsWith("/comments")) return json({ id: 901, user: { login: "butchr-bot" }, body: JSON.parse(init!.body as string).body, created_at: "c", updated_at: "c" });
    if (url.endsWith("/comments") || url.includes("/comments?")) return json([{ id: 5, user: { login: "reviewer" }, body: "ping", created_at: "t", updated_at: "t" }]);
    const m = /\/pulls\/(\d+)$/.exec(url);
    const number = m?.[1];
    return number && number in prs ? json(prs[number]) : json({}, 404);
  };
  return { calls, client: createGithubPrClient({ fetchImpl, token: "fake-token-for-tests", orgs: ["acme"] }) };
}

const apiPr = (over: Record<string, unknown> = {}) => ({
  title: "Fix the thing", body: "Does the fix.", state: "open", merged: false, draft: false, labels: [{ name: "bug" }], comments: 1, updated_at: "2026-09-16T10:00:00Z", html_url: "https://github.com/acme/w/pull/12", ...over,
});

describe("github-pr tools", () => {
  const prs = { 12: apiPr() };

  test("exactly a read and a comment tool, comment takes only text", () => {
    const tools = githubPrTools({ client: fakeGithub(prs).client, log: () => {} });
    expect(Object.keys(tools).sort()).toEqual(["github_get_pr", "github_pr_add_comment"]);
    expect(Object.keys(tools.github_pr_add_comment!.input)).toEqual(["text"]);
    expect(Object.keys(tools.github_get_pr!.input)).toEqual([]);
  });

  test("github_get_pr reads the caller's own PR and its comments — merged/draft included", async () => {
    const { client, calls } = fakeGithub(prs);
    const tools = githubPrTools({ client, log: () => {} });
    expect(await call(tools, "github_get_pr", {}, prCaller)).toMatchObject({
      pr: "acme/w#12", url: "https://github.com/acme/w/pull/12", title: "Fix the thing", state: "open", merged: false, draft: false, labels: ["bug"],
      comments: [{ id: "5", author: "reviewer", body: "ping" }],
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("github_pr_add_comment tags a comment on the caller's own PR and records the write for echo suppression", async () => {
    const { client, calls } = fakeGithub(prs);
    const writes: string[][] = [];
    const tools = githubPrTools({ client, onWrite: (r, u, w) => writes.push([r, u, w]), log: () => {} });
    expect(await call(tools, "github_pr_add_comment", { text: "Looks good." }, prCaller)).toEqual({ ok: true, pr: "acme/w#12", comment: "901" });
    const posted = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(posted.body!)).toEqual({ body: `${githubPrCommentTag("prs")} Looks good.` });
    expect(writes).toEqual([["acme/w#12", "2026-09-16T10:00:00Z", PR]]);
  });

  test("a read-back failure after posting is logged, never a tool error", async () => {
    const { client } = fakeGithub(prs);
    const logs: string[] = [];
    const tools = githubPrTools({ client: { ...client, get: async () => { throw new Error("boom"); } }, onWrite: () => { throw new Error("unreached"); }, log: (l) => logs.push(l) });
    expect(await call(tools, "github_pr_add_comment", { text: "hi" }, prCaller)).toMatchObject({ ok: true });
    expect(logs.some((l) => l.includes("own-write read-back failed"))).toBe(true);
  });

  test("no cross-provider calls: other callers are refused github-pr tools, and a github-pr agent reaches no Jira or github-issue tool", async () => {
    const { client, calls } = fakeGithub(prs);
    const tools = githubPrTools({ client, log: () => {} });
    for (const c of [
      { headers: { "x-issue": "BUTCHR-1", "x-butchr-agent": JIRA } },
      { headers: { "x-issue": "BUTCHR-1" } },
      { headers: { "x-butchr-agent": ISSUE } },
      { headers: {} },
    ]) {
      await expect(call(tools, "github_pr_add_comment", { text: "x" }, c)).rejects.toBeInstanceOf(Refusal);
      await expect(call(tools, "github_get_pr", {}, c)).rejects.toBeInstanceOf(Refusal);
    }
    expect(calls).toEqual([]);

    const jiraCalls: unknown[] = [];
    const jira = forJiraCallers({ jira_add_comment: { description: "d", input: {}, handler: (a) => { jiraCalls.push(a); return "ok"; } } }, () => {});
    await expect(call(jira, "jira_add_comment", { key: "BUTCHR-1", text: "x" }, prCaller)).rejects.toThrow("use github_get_pr and github_pr_add_comment");
    expect(jiraCalls).toEqual([]);

    // Another repo's agent key decodes, but the client refuses before any request.
    await expect(call(tools, "github_pr_add_comment", { text: "x" }, { headers: { "x-butchr-agent": "github-pr:prs:evil%2Fw%2312" } })).rejects.toThrow("outside BUTCHR_GITHUB_ORGS");
  });

  test("a query-level (singleton/persistent) github-pr caller has no single PR to act on, and is refused like any other provider's query caller", async () => {
    const tools = githubPrTools({ client: fakeGithub(prs).client, log: () => {} });
    const queryCaller = { headers: { "x-butchr-agent": "github-pr:prs:%40query" } };
    await expect(call(tools, "github_get_pr", {}, queryCaller)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("githubPrCommentTag", () => {
  test("same bracketed shape as github-issue's own tag", () => {
    expect(githubPrCommentTag("prs")).toBe("[butchr prs]");
  });
});

describe("parseGithubPrRef sanity for the fixtures above", () => {
  test("acme/w#12 round-trips", () => {
    expect(parseGithubPrRef("acme/w#12")).toEqual({ owner: "acme", repo: "w", number: 12 });
  });
});
