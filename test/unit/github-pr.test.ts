import { describe, expect, test } from "bun:test";
import type { Herd } from "../../src/agents/herd.js";
import { githubPrNudge } from "../../src/agents/change-nudge.js";
import { agentIdOfWorkspacePath, resourceKeyOf, workspaceDirFor } from "../../src/agents/workspace.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createGithubPrClient, githubPrQueryProblems, GithubHttpError, mapGithubPr, scopedPrQuery, type GithubPr } from "../../src/resources/github-pr.js";
import { formatGithubPrRef, isGithubPrRef, parseGithubPrRef } from "../../src/resources/github-pr-ref.js";
import { decodeAgentKey, encodeAgentKey } from "../../src/rules/agent-key.js";
import { createGithubPrEventRules, createGithubPrResourceType, githubPrStaffing, ownsGithubPrAgent, searchGithubPrRules, specForGithubPr, type GithubPrMatch } from "../../src/rules/github-pr-type.js";
import { ownsRuleAgent, searchRules } from "../../src/rules/resource-type.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";

const prRules = (...docs: object[]): Rule[] =>
  parseRules({ rules: docs.map((d) => ({ resourceProvider: "github-pr", brief: "review it", ...d })) });

const gp = (ref: string, over: Partial<GithubPr> = {}): GithubPr => {
  const r = parseGithubPrRef(ref)!;
  return { ref, owner: r.owner, repo: r.repo, number: r.number, title: `title ${ref}`, body: "body", state: "open", merged: false, draft: false, labels: [], comments: 0, updated: "2026-09-16T00:00:00Z", url: `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`, ...over };
};

const item = (owner: string, repo: string, number: number, over: Record<string, unknown> = {}) => ({
  number, title: `t${number}`, body: "b", state: "open", draft: false, labels: [{ name: "z" }, { name: "a" }], comments: 2,
  updated_at: "2026-09-16T00:00:00Z", html_url: `https://github.com/${owner}/${repo}/pull/${number}`, repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  pull_request: { merged_at: null }, ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("github pr identity", () => {
  test("owner/repo#number is canonical lowercase and round-trips", () => {
    expect(formatGithubPrRef({ owner: "Acme", repo: "Widgets.js", number: 12 })).toBe("acme/widgets.js#12");
    expect(parseGithubPrRef("acme/widgets.js#12")).toEqual({ owner: "acme", repo: "widgets.js", number: 12 });
    for (const bad of ["Acme/widgets#1", "acme/widgets#0", "acme/w", "PROJ-1"]) expect(isGithubPrRef(bad)).toBe(false);
  });

  test("agent keys escape the ref and map to a three-deep workspace owned only by the github-pr loop", () => {
    const key = encodeAgentKey({ resourceProvider: "github-pr", ruleId: "prs", resourceId: "acme/widgets#12" });
    expect(key).toBe("github-pr:prs:acme%2Fwidgets%2312");
    expect(decodeAgentKey(key)).toEqual({ resourceProvider: "github-pr", ruleId: "prs", resourceId: "acme/widgets#12" });
    const dir = workspaceDirFor(key, "/root");
    expect(dir).toBe("/root/github-pr/prs/acme%2Fwidgets%2312");
    expect(agentIdOfWorkspacePath(dir, "/root")).toBe(key);
    expect(resourceKeyOf(key)).toBe("acme/widgets#12");
    expect(ownsGithubPrAgent(key)).toBe(true);
    expect(ownsRuleAgent(key)).toBe(false);
    expect(ownsGithubPrAgent("jira-work:task:BUTCHR-1")).toBe(false);
    // A github-issue agent key is never mistaken for a github-pr one, even
    // though the two share the same owner/repo#n resource-id shape.
    const issueKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "prs", resourceId: "acme/widgets#12" });
    expect(ownsGithubPrAgent(issueKey)).toBe(false);
  });
});

describe("github-pr rule queries", () => {
  test("plain issues, org scoping and boolean operators are refused; ordinary qualifiers pass", () => {
    expect(githubPrQueryProblems('is:open review-requested:@me label:"needs review" repo:acme/widgets -label:wip "a OR b"')).toEqual([]);
    for (const q of ["is:issue", "-is:pr", "org:acme", "user:x", "owner:x", "a OR b", "NOT a", "(a b)", "repo:nope"]) {
      expect(githubPrQueryProblems(q).length).toBeGreaterThan(0);
    }
  });

  test("rules validate github-pr queries, and refuse github-pr relationships and cross-provider references", () => {
    expect(prRules({ id: "prs", query: "is:open", agentPreferences: [{ harness: "claude" }] })[0]).toMatchObject({ resourceProvider: "github-pr", query: "is:open" });
    expect(() => prRules({ id: "issues", query: "is:issue" })).toThrow("never issues");
    expect(() => prRules({ id: "a", query: "x", relationships: { inwardConnectionRules: [] } })).toThrow("not supported for github-pr");
    expect(() => parseRules({ rules: [
      { id: "epic", resourceProvider: "jira-work", query: "q", brief: "b", relationships: { childRule: "prs" } },
      { id: "prs", resourceProvider: "github-pr", query: "is:open", brief: "b" },
    ] })).toThrow("cross-provider");
  });

  test("scope is the configured orgs, or repo: qualifiers inside them — never both, never outside", () => {
    expect(scopedPrQuery("is:open", ["Acme", "beta"])).toBe("is:open is:pr org:acme org:beta");
    expect(scopedPrQuery("is:open repo:Acme/widgets", ["acme"])).toBe("is:open repo:Acme/widgets is:pr");
    expect(() => scopedPrQuery("repo:evil/x", ["acme"])).toThrow("outside BUTCHR_GITHUB_ORGS");
    expect(() => scopedPrQuery("is:open", [])).toThrow("BUTCHR_GITHUB_ORGS");
    expect(() => scopedPrQuery("is:issue", ["acme"])).toThrow("rejected");
  });

  test("the jira rule search and the github-issue search never run github-pr rules, and vice versa", async () => {
    const seen: string[] = [];
    const rules = [
      ...prRules({ id: "prs", query: "is:open" }),
      ...parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "jql", brief: "b" }] }),
    ];
    await searchRules({ rules, search: async (q) => { seen.push(q); return []; } });
    await searchGithubPrRules({ rules, search: async (q) => { seen.push(q); return []; } });
    expect(seen).toEqual(["jql", "is:open"]);
  });
});

describe("github pr client", () => {
  test("maps pull requests, tells merged from unmerged, drops plain issues and malformed items", () => {
    expect(mapGithubPr(item("Acme", "Widgets", 3))).toEqual({
      ref: "acme/widgets#3", owner: "acme", repo: "widgets", number: 3, title: "t3", body: "b", state: "open", merged: false, draft: false,
      labels: ["a", "z"], comments: 2, updated: "2026-09-16T00:00:00Z", url: "https://github.com/Acme/Widgets/pull/3",
    });
    expect(mapGithubPr(item("acme", "w", 4, { state: "closed", pull_request: { merged_at: "2026-09-20T00:00:00Z" } }))!.merged).toBe(true);
    expect(mapGithubPr(item("acme", "w", 5, { pull_request: undefined }))).toBeNull(); // a plain issue
    expect(mapGithubPr(item("acme", "w", 0))).toBeNull();
    expect(mapGithubPr(item("acme", "w", 6, { repository_url: "nope" }))).toBeNull();
    expect(mapGithubPr(item("a b", "w", 7))).toBeNull();
    expect(mapGithubPr({ ...item("acme", "w", 8, { body: null, labels: ["x"], draft: "nope" }), title: undefined, state: undefined, comments: undefined, updated_at: undefined, html_url: undefined })).toMatchObject({ body: "", labels: ["x"], title: "", state: "unknown", comments: 0, draft: false });
  });

  test("searchAll reads every page in created order with auth, scoping and issue/owner filtering", async () => {
    const urls: string[] = [];
    let auth: string | undefined;
    const page1 = Array.from({ length: 100 }, (_, i) => item("acme", "w", i + 1));
    const fetchImpl = async (url: string, init?: RequestInit) => {
      urls.push(url);
      auth = (init?.headers as Record<string, string>).authorization;
      const page = new URL(url).searchParams.get("page");
      return json(page === "1" ? { total_count: 103, incomplete_results: false, items: page1 }
        : { total_count: 103, incomplete_results: false, items: [item("acme", "w", 101, { pull_request: undefined }), item("other", "w", 102), item("acme", "w", 1)] });
    };
    const logs: string[] = [];
    const client = createGithubPrClient({ fetchImpl, token: "tok", orgs: ["acme"], log: (l) => logs.push(l) });
    const prs = await client.searchAll("is:open");
    expect(prs.length).toBe(100);
    expect(auth).toBe("Bearer tok");
    expect(urls.length).toBe(2);
    const params = new URL(urls[0]!).searchParams;
    expect([params.get("q"), params.get("sort"), params.get("order"), params.get("per_page")]).toEqual(["is:open is:pr org:acme", "created", "asc", "100"]);
    expect(logs).toEqual(["[github-pr] dropped other/w#102: owner outside BUTCHR_GITHUB_ORGS"]);
  });

  test("searchAll rejects rather than returning a partial list", async () => {
    const client = (body: unknown, status = 200) => createGithubPrClient({ fetchImpl: async () => json(body, status), token: "t", orgs: ["acme"] });
    await expect(client({}, 403).searchAll("x")).rejects.toBeInstanceOf(GithubHttpError);
    await expect(client({ total_count: 1, incomplete_results: true, items: [] }).searchAll("x")).rejects.toThrow("incomplete");
    await expect(client({ total_count: 1001, incomplete_results: false, items: [] }).searchAll("x")).rejects.toThrow("over the 1000");
    await expect(client({ items: [] }).searchAll("x")).rejects.toThrow("unexpected body");
  });

  test("get reads /pulls/<n> directly (never /issues/<n>) and rejects an owner outside the configured orgs", async () => {
    const urls: string[] = [];
    const client = createGithubPrClient({
      token: "t", orgs: ["acme"],
      fetchImpl: async (url) => { urls.push(url); return json({ title: "t", body: "b", state: "closed", merged: true, draft: false, labels: [{ name: "x" }], comments: 1, updated_at: "u", html_url: "h" }); },
    });
    const pr = await client.get({ owner: "acme", repo: "w", number: 9 });
    expect(urls[0]).toBe("https://api.github.com/repos/acme/w/pulls/9");
    expect(pr).toEqual({ ref: "acme/w#9", owner: "acme", repo: "w", number: 9, title: "t", body: "b", state: "closed", merged: true, draft: false, labels: ["x"], comments: 1, updated: "u", url: "h" });
    await expect(client.get({ owner: "evil", repo: "w", number: 1 })).rejects.toThrow("outside BUTCHR_GITHUB_ORGS");
  });

  test("comments reads every page over the issue-comments endpoint (a PR is an issue) and fails loudly", async () => {
    const urls: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: "u" }, body: "c", created_at: "t", updated_at: "t" }));
    const client = createGithubPrClient({
      token: "t", orgs: ["acme"],
      fetchImpl: async (url) => { urls.push(url); return json(url.endsWith("&page=1") ? full : [{ id: 999, user: null, body: null }]); },
    });
    const comments = await client.comments({ owner: "acme", repo: "w", number: 7 });
    expect(comments.length).toBe(101);
    expect(comments.at(-1)).toEqual({ id: "999", author: null, body: "", created: "", updated: "" });
    expect(urls[0]).toBe("https://api.github.com/repos/acme/w/issues/7/comments?per_page=100&page=1");
    await expect(createGithubPrClient({ token: "t", orgs: [], fetchImpl: async () => json({}) }).comments({ owner: "a", repo: "w", number: 1 })).rejects.toThrow("unexpected body");
    await expect(createGithubPrClient({ token: "t", orgs: [], fetchImpl: async () => json(full) }).comments({ owner: "a", repo: "w", number: 1 })).rejects.toThrow("exceed 3000");
  });

  test("addComment re-reads (get) before posting, on the issue-comments endpoint", async () => {
    const calls: string[] = [];
    const client = createGithubPrClient({
      token: "t", orgs: ["acme"],
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "POST") return json({ id: 1, user: { login: "bot" }, body: "hi", created_at: "c", updated_at: "c" });
        return json({ title: "t", body: "b", state: "open", merged: false, draft: false, labels: [], comments: 0, updated_at: "u", html_url: "h" });
      },
    });
    const comment = await client.addComment({ owner: "acme", repo: "w", number: 4 }, "hi");
    expect(comment.id).toBe("1");
    expect(calls[0]).toBe("GET https://api.github.com/repos/acme/w/pulls/4");
    expect(calls[1]).toBe("POST https://api.github.com/repos/acme/w/issues/4/comments");
  });
});

describe("github-pr staffing (fail-loudly gate)", () => {
  test("no enabled github-pr rules: silent no-op", () => {
    expect(githubPrStaffing([], undefined)).toEqual({ run: false, rules: [], reason: null });
  });

  test("missing token/orgs names the setting by name, same style as github-issue", () => {
    const rules = prRules({ id: "prs", query: "is:open" });
    expect(githubPrStaffing(rules, undefined)).toEqual({ run: false, rules, reason: "github-pr rules not staffed (prs): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS" });
  });

  test("a query that cannot be scoped to the configured orgs is named in the reason", () => {
    const rules = prRules({ id: "prs", query: "repo:evil/x" });
    const staffing = githubPrStaffing(rules, { token: "t", orgs: ["acme"] });
    if (staffing.run) throw new Error("expected run: false");
    expect(staffing.reason).toContain("prs: github-pr query names repo:evil/x outside BUTCHR_GITHUB_ORGS");
  });

  test("token and orgs present, every query scopes cleanly: staffed", () => {
    const rules = prRules({ id: "prs", query: "is:open" });
    expect(githubPrStaffing(rules, { token: "t", orgs: ["acme"] })).toEqual({ run: true, rules });
  });
});

describe("githubPrNudge", () => {
  test("names github_get_pr, never github_get_issue — the twin of githubIssueNudge", () => {
    expect(githubPrNudge("acme/w#1", { summary: true })).toBe("[butchr] GitHub pull request acme/w#1 had its title edited — re-read it with github_get_pr.");
    expect(githubPrNudge("acme/w#1", { status: { from: "open", to: "merged" } })).toBe('[butchr] GitHub pull request acme/w#1 changed status from "open" to "merged" — re-read it with github_get_pr.');
  });
});

describe("github pr resource type", () => {
  const [rule] = prRules({ id: "prs", query: "is:open", agentPreferences: [{ harness: "claude", effort: "high" }] });
  const match = (ref: string, over: Partial<GithubPr> = {}): GithubPrMatch =>
    ({ agentKey: encodeAgentKey({ resourceProvider: "github-pr", ruleId: "prs", resourceId: ref }), rule: rule!, pr: gp(ref, over) });

  test("spawn spec names the PR ref, its issuetype and the rule's brief", () => {
    expect(specForGithubPr(match("acme/w#1"))).toEqual({
      key: "github-pr:prs:acme%2Fw%231", resource: "acme/w#1", issuetype: "pr", summary: "title acme/w#1", parent: null,
      brief: "review it", agents: [{ harness: "claude", effort: "high" }],
    });
  });

  test("event rules: no notice on appear, disappear or updated-only; reasons for merge/state, comment, title, other", async () => {
    const snap = (...m: GithubPrMatch[]) => ({ primary: m.map((match) => ({ kind: "resource" as const, match })), related: [] });
    const logs: string[] = [];
    let fail = false;
    const rules = createGithubPrEventRules({
      comments: async (ref) => { if (fail) throw new Error("boom"); return ref.number === 5 ? [] : [{ id: "c1", author: "u", body: "looks good", created: "", updated: "" }]; },
      log: (l) => logs.push(l),
    });
    const verdict = async (from: Partial<GithubPr>, to: Partial<GithubPr>, ref = "acme/w#1") => {
      const p = await rules.poll(snap(match(ref, from)), snap(match(ref, to)));
      const [key] = p.changedPrimary;
      return key ? p.decide(key, key, "primary") : null;
    };
    const appear = await rules.poll(snap(), snap(match("acme/w#1")));
    expect(appear.changedPrimary).toEqual([]);
    expect((await rules.poll(snap(match("acme/w#1")), snap())).changedPrimary).toEqual([]);
    expect(await verdict({}, { updated: "later" })).toBeNull();
    expect(await verdict({}, { state: "closed", comments: 1 })).toEqual({ deliver: true, reason: { status: { from: "open", to: "closed" } } as NotifyReason });
    expect(await verdict({ state: "open" }, { state: "closed", merged: true, comments: 1 })).toEqual({ deliver: true, reason: { status: { from: "open", to: "merged" } } as NotifyReason });
    expect(await verdict({}, { comments: 1, title: "x" })).toEqual({ deliver: true, reason: { comment: "c1" } });
    expect(await verdict({}, { comments: 1 }, "acme/w#5")).toEqual({ deliver: true, reason: { undetermined: "checked-unchanged" } });
    expect(await verdict({}, { title: "new" })).toEqual({ deliver: true, reason: { summary: true } });
    expect(await verdict({}, { labels: ["p1"] })).toEqual({ deliver: true });
    fail = true;
    expect(await verdict({}, { comments: 1 })).toEqual({ deliver: true, reason: { undetermined: "check-failed" } });
    expect(logs[0]).toContain("comments for acme/w#1 failed");
  });

  test("through the unmodified loop: staffs matches, notifies without PR text, stops the agent when the PR flips to merged (drops out of an is:open-scoped query)", async () => {
    const running = new Set<string>();
    const spawned: string[] = [], stopped: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running, "jira-work:task:BUTCHR-1", "BUTCHR-2"]; },
      async staleIssues() { return []; },
      async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
      async stop(i) { stopped.push(i); running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
    };
    let prs = [gp("acme/w#1")];
    const notified: Array<[string, NotifyReason | undefined]> = [];
    const type = createGithubPrResourceType({ rules: prRules({ id: "prs", query: "is:open" }), search: async () => prs });
    const stop = runResourceLoop(type, { herd, ownsId: ownsGithubPrAgent, notify: (a, _about, reason) => { notified.push([a, reason]); }, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toEqual(["github-pr:prs:acme%2Fw%231"]);
    prs = [gp("acme/w#1", { title: "renamed" })];
    await new Promise((r) => setTimeout(r, 30));
    expect(notified).toContainEqual(["github-pr:prs:acme%2Fw%231", { summary: true }]);
    // The rule's own query (an "is:open"-style scope) is what drives the
    // lifecycle: once merged/closed, the mocked search simply stops
    // returning the PR, exactly the mechanism github-issue relies on for a
    // closed issue — no special-cased merge/close code in this type at all.
    prs = [];
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(stopped).toEqual(["github-pr:prs:acme%2Fw%231"]);
  });

  test("stops the agent on close too, the same way — merged and closed-without-merging are both just 'left the query'", async () => {
    const running = new Set<string>();
    const spawned: string[] = [], stopped: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
      async stop(i) { stopped.push(i); running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
    };
    let prs = [gp("acme/w#2")];
    const type = createGithubPrResourceType({ rules: prRules({ id: "prs", query: "is:open" }), search: async () => prs });
    const stop = runResourceLoop(type, { herd, ownsId: ownsGithubPrAgent, notify: async () => {}, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toEqual(["github-pr:prs:acme%2Fw%232"]);
    prs = []; // closed without merging: an is:open-scoped search stops returning it too
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(stopped).toEqual(["github-pr:prs:acme%2Fw%232"]);
  });
});
