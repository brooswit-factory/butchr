import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/** Defaults for the get_doc/set_doc ops (BUTCHR-33), the label/delete ops (BUTCHR-35) and correctText (BUTCHR-60) shared by every rig() below; override per test as needed. */
function fakeDocOps(overrides: Partial<Pick<AtlassianOps, "getProjectProperty" | "getRemoteLink" | "upsertRemoteLink" | "getChildPages" | "getPageLabels" | "createPageWithLabel" | "addLabels" | "removeLabels" | "deleteIssue" | "correctText">> = {}) {
  return {
    getProjectProperty: async () => ({ space: { key: "KAN" }, rootDoc: { id: "1" } }),
    getRemoteLink: async () => null,
    upsertRemoteLink: async () => ({ id: 1 }),
    getChildPages: async () => ({ results: [] }),
    getPageLabels: async () => [],
    createPageWithLabel: async () => ({ id: "999", title: "t", url: "https://x/999" }),
    addLabels: async () => ({ ok: true }),
    removeLabels: async () => ({ ok: true }),
    deleteIssue: async () => ({ ok: true }),
    correctText: async () => ({ ok: true }),
    ...overrides,
  };
}

function rig(roles: { story?: string; task?: string } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, result: unknown = { ok: name }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
  const ops: AtlassianOps = {
    getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"),
    transition: rec("transition"), createIssue: rec("createIssue", { key: "KAN-999" }), setPriority: rec("setPriority"),
    assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"), searchPages: rec("searchPages", { results: [] }), listSpaces: rec("listSpaces"),
    ...fakeDocOps({ correctText: rec("correctText") }),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: "test-account" }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
  };
  const audits: string[] = [];
  const tools = atlassianTools(ops, (l) => audits.push(l), roles);
  const conn = { headers: { "x-issue": "KAN-7" } } as any;
  return { tools, calls, audits, conn };
}

describe("atlassianTools", () => {
  test("exposes the full proxy surface — alias-completeness: every pre-existing name still resolves, plus the ten relationship verbs (BUTCHR-35) and file_where_it_belongs (BUTCHR-37)", () => {
    const { tools } = rig();
    expect(Object.keys(tools).sort()).toEqual([
      "adopt_worker", "ask_boss",
      "check_in",
      "confluence_create_page", "confluence_get_page", "confluence_list_spaces", "confluence_search_pages", "confluence_update_page",
      "correct_worker",
      "file_where_it_belongs", "finish_without_a_boss", "finish_worker",
      "get_doc", "get_doc_comments",
      "jira_add_comment", "jira_assign", "jira_create_issue", "jira_get_issue", "jira_link_issues", "jira_search",
      "jira_set_priority", "jira_transition",
      "list_peers",
      "new_worker", "prioritize_worker", "report_to_boss",
      "set_doc", "shelve_worker", "start_worker", "submit_to_boss",
      "tell_worker",
    ]);
  });

  test("the five permanent verbs carry NO deprecation note; the eight aliased ones do", () => {
    const { tools } = rig();
    const permanent = ["jira_get_issue", "jira_search", "jira_add_comment", "confluence_list_spaces", "confluence_search_pages"];
    const aliased = ["jira_link_issues", "jira_transition", "jira_create_issue", "jira_set_priority", "jira_assign", "confluence_create_page", "confluence_update_page", "confluence_get_page"];
    for (const name of permanent) expect(tools[name]!.description).not.toMatch(/DEPRECATED/);
    for (const name of aliased) expect(tools[name]!.description).toMatch(/DEPRECATED/);
  });
  test("each tool routes to its op and audits the caller's issue", async () => {
    const { tools, calls, audits, conn } = rig();
    await tools.jira_get_issue!.handler({ key: "KAN-1" }, conn);
    await tools.jira_search!.handler({ jql: "project = KAN", maxResults: 5 }, conn);
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "hi" }, conn);
    await tools.jira_transition!.handler({ key: "KAN-1", status: "In Review" }, conn);
    // Task with no configured role, but an explicit assignee: no refusal. `parent`
    // given and `implements` absent, so the tool ALSO auto-links to the parent —
    // that's the extra "linkIssues" call between createIssue and the explicit one.
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", parent: "KAN-2", assignee: "acct-1" }, conn);
    await tools.jira_link_issues!.handler({ from: "KAN-2", to: "KAN-9" }, conn);
    await tools.jira_set_priority!.handler({ key: "KAN-1", priority: "High" }, conn);
    await tools.confluence_create_page!.handler({ spaceId: "1", title: "t", body: "<p/>" }, conn);
    await tools.confluence_get_page!.handler({ id: "9" }, conn);
    await tools.confluence_update_page!.handler({ id: "9", body: "<p/>" }, conn);
    await tools.confluence_search_pages!.handler({ titleContains: "log" }, conn);
    await tools.confluence_list_spaces!.handler({}, conn);
    expect(calls.map(([n]) => n)).toEqual(["getIssue", "search", "addComment", "transition", "createIssue", "linkIssues", "linkIssues", "setPriority", "createPage", "getPage", "updatePage", "searchPages", "listSpaces"]);
    expect(calls[1]![1]).toEqual(["project = KAN", 5]);
    expect((calls[4]![1][0] as { assignee?: string }).assignee).toBe("acct-1");   // assignee reaches the op
    expect(calls[5]![1]).toEqual(["KAN-999", "KAN-2", "Implements"]);             // create's own auto-link, to the parent
    expect(calls[6]![0]).toBe("linkIssues");
    expect(calls[6]![1]).toEqual(["KAN-2", "KAN-9", "Implements"]);               // the explicit jira_link_issues call; default type applied
    expect(audits.every((a) => a.includes("KAN-7"))).toBe(true);
    expect(audits.length).toBe(12);
  });
  test("search defaults maxResults when omitted", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_search!.handler({ jql: "x" }, conn);
    expect(calls[0]![1]).toEqual(["x", 25]);
  });
  test("jira_link_issues honors an explicit type over the default", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_link_issues!.handler({ from: "KAN-2", to: "KAN-9", type: "Blocks" }, conn);
    expect(calls[0]![1]).toEqual(["KAN-2", "KAN-9", "Blocks"]);
  });
});

describe("jira_transition: pinning test — still works exactly as it does today (BUTCHR-39)", () => {
  test("moves ANY key to ANY status, with no ownership check and no refusal finish_without_a_boss now adds for the bossless-Done case", async () => {
    const { tools, calls, audits, conn } = rig();
    // A key that is neither the caller's own nor one of its workers — jira_transition
    // has never checked ownership, and finish_without_a_boss's arrival must not change that.
    await tools.jira_transition!.handler({ key: "SOMEONE-ELSE-1", status: "Done" }, conn);
    expect(calls).toEqual([["transition", ["SOMEONE-ELSE-1", "Done"]]]);
    expect(audits[0]).toContain("transition SOMEONE-ELSE-1 → Done");
    expect(audits[0]).toContain("[deprecated alias; use start_worker/shelve_worker/finish_worker/submit_to_boss]");
  });

  test("still names finish_without_a_boss in its deprecation note, alongside the other successors", () => {
    const { tools } = rig();
    expect(tools.jira_transition!.description).toMatch(/finish_without_a_boss/);
  });
});

describe("jira_link_issues invalid MCP result (KAN-764)", () => {
  test("substitutes a real value when the op resolves undefined (Jira's empty 201 body)", async () => {
    const { conn } = rig();
    const ops: AtlassianOps = {
      getIssue: async () => ({}), search: async () => ({}), addComment: async () => ({}),
      linkIssues: async () => undefined, transition: async () => ({}), createIssue: async () => ({}),
      setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const result = await tools.jira_link_issues!.handler({ from: "KAN-2", to: "KAN-9" }, conn);
    expect(result).toEqual({ ok: true, from: "KAN-2", to: "KAN-9", type: "Implements" });
  });
});


describe("priority", () => {
  test("jira_create_issue passes priority through when given", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", priority: "High", assignee: "acct-x", implements: "none" }, conn);
    expect((calls[0]![1][0] as { priority?: string }).priority).toBe("High");
  });
  test("jira_create_issue omits priority when not given", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", assignee: "acct-x", implements: "none" }, conn);
    expect((calls[0]![1][0] as { priority?: string }).priority).toBeUndefined();
  });
  test("jira_set_priority routes to ops.setPriority and audits the caller's issue", async () => {
    const { tools, calls, audits, conn } = rig();
    await tools.jira_set_priority!.handler({ key: "KAN-1", priority: "High" }, conn);
    expect(calls[0]).toEqual(["setPriority", ["KAN-1", "High"]]);
    expect(audits.some((a) => a.includes("KAN-7"))).toBe(true);
  });
});

describe("onWrite hook (own-write ledger feed)", () => {
  function rigWithOnWrite() {
    const ops: AtlassianOps = {
      getIssue: async () => ({}), search: async () => ({}), addComment: async () => ({ ok: true }),
      linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async (p) => ({ key: `KAN-${p.summary.length}` }), setPriority: async () => ({ ok: true }),
      assign: async () => ({ ok: true }),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, () => {}, {}, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-7" } } as any;
    return { tools, writes, conn };
  }

  test("jira_add_comment/jira_transition/jira_set_priority/jira_assign fire onWrite with the single key", async () => {
    const { tools, writes, conn } = rigWithOnWrite();
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "hi" }, conn);
    await tools.jira_transition!.handler({ key: "KAN-2", status: "In Review" }, conn);
    await tools.jira_set_priority!.handler({ key: "KAN-3", priority: "High" }, conn);
    await tools.jira_assign!.handler({ key: "KAN-4", assignee: "acct-x" }, conn);
    expect(writes).toEqual([[["KAN-1"], "KAN-7"], [["KAN-2"], "KAN-7"], [["KAN-3"], "KAN-7"], [["KAN-4"], "KAN-7"]]);
  });

  test("jira_link_issues fires onWrite with BOTH ends", async () => {
    const { tools, writes, conn } = rigWithOnWrite();
    await tools.jira_link_issues!.handler({ from: "KAN-2", to: "KAN-9" }, conn);
    expect(writes).toEqual([[["KAN-2", "KAN-9"], "KAN-7"]]);
  });

  test("jira_create_issue fires onWrite with the created key, and again with BOTH ends of the Implements link it creates", async () => {
    const { tools, writes, conn } = rigWithOnWrite();
    // Since 0.10.0 a Task must be staffed and must name what it implements —
    // the tool creates that link itself, which bumps `updated` on both ends.
    await tools.jira_create_issue!.handler(
      { projectKey: "KAN", issuetype: "Task", summary: "abc", assignee: "acct-1", implements: "KAN-9" },
      conn,
    );
    expect(writes).toEqual([[["KAN-3"], "KAN-7"], [["KAN-3", "KAN-9"], "KAN-7"]]);
  });

  test("jira_get_issue/jira_search (read tools) never fire onWrite", async () => {
    const { tools, writes, conn } = rigWithOnWrite();
    await tools.jira_get_issue!.handler({ key: "KAN-1" }, conn);
    await tools.jira_search!.handler({ jql: "x" }, conn);
    expect(writes).toEqual([]);
  });

  test("a call with no x-issue header never fires onWrite (never record an unknown writer)", async () => {
    const { tools, writes } = rigWithOnWrite();
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "hi" }, { headers: {} } as any);
    expect(writes).toEqual([]);
  });

  test("onWrite is optional — omitting it changes nothing about the tool's own behavior", async () => {
    const { tools, calls, conn } = rig();
    const result = await tools.jira_add_comment!.handler({ key: "KAN-1", text: "hi" }, conn);
    expect(result).toEqual({ ok: "addComment" });
    expect(calls.map(([n]) => n)).toEqual(["addComment"]);
  });
});

describe("comment identity tagging", () => {
  test("prepends the caller's issue tag; idempotent when already tagged", async () => {
    const { tools, calls, conn } = rig();               // conn carries x-issue KAN-7
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "status looks good" }, conn);
    await tools.jira_add_comment!.handler({ key: "KAN-1", text: "[KAN-7] already tagged" }, conn);
    const bodies = calls.filter(([n]) => n === "addComment").map(([, a]) => a[1]);
    expect(bodies[0]).toBe("[KAN-7] status looks good");
    expect(bodies[1]).toBe("[KAN-7] already tagged");    // no double tag
  });
});

describe("jira_create_issue: role assignment, implements/parent resolution, orphan opt-out (KAN-802)", () => {
  const STORY_ID = "712020:e160cf60-6480-44de-8554-af5b81c584e2";
  const TASK_ID = "712020:619ec5ec-2e92-492f-8979-91ccda318230";
  const roles = { story: STORY_ID, task: TASK_ID };

  function rig(customRoles: { story?: string; task?: string } = roles, opsOverrides: Partial<AtlassianOps> = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string, result: unknown = { ok: name }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
    const ops: AtlassianOps = {
      getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"),
      linkIssues: rec("linkIssues"), transition: rec("transition"),
      createIssue: rec("createIssue", { key: "KAN-999" }), setPriority: rec("setPriority"),
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"), searchPages: rec("searchPages"), listSpaces: rec("listSpaces"),
      ...fakeDocOps(),
      ...opsOverrides,
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), customRoles);
    const conn = { headers: { "x-issue": "KAN-7" } } as any;
    return { tools, calls, audits, conn };
  }

  // (a) role resolution for Story AND Task, each with a parent and without one.
  test("Story WITH parent: role assignee reaches ops.createIssue", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", parent: "KAN-794" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe(STORY_ID);
  });
  test("Story WITHOUT parent (implements given): role assignee reaches ops.createIssue", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe(STORY_ID);
  });
  test("Task WITH parent (and implements, since parent can't be the story): role assignee reaches ops.createIssue regardless of parent", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", parent: "KAN-794", implements: "KAN-795" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe(TASK_ID);
  });
  test("Task WITHOUT parent (implements given): role assignee reaches ops.createIssue", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", implements: "KAN-795" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe(TASK_ID);
  });

  // (b) explicit assignee overrides the role mapping.
  test("an explicit assignee argument overrides the role mapping", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794", assignee: "acct-explicit" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe("acct-explicit");
  });

  // (c) missing role config + no explicit assignee -> refuses, ops.createIssue NOT called, error names the env var,
  // AND the refusal itself leaves a trace in the daemon log (a refused create is still something a connection did).
  test("missing BUTCHR_ASSIGNEE_STORY + no explicit assignee refuses, names the env var, and audits the refusal", async () => {
    const { tools, calls, audits, conn } = rig({});
    await expect(tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794" }, conn))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_STORY/);
    expect(calls.find(([n]) => n === "createIssue")).toBeUndefined();
    expect(audits.some((a) => a.includes("REFUSED: no assignee (BUTCHR_ASSIGNEE_STORY unset)"))).toBe(true);
  });
  test("missing BUTCHR_ASSIGNEE_TASK + no explicit assignee refuses, names the env var, and audits the refusal", async () => {
    const { tools, calls, audits, conn } = rig({});
    await expect(tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", implements: "KAN-795" }, conn))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_TASK/);
    expect(calls.find(([n]) => n === "createIssue")).toBeUndefined();
    expect(audits.some((a) => a.includes("REFUSED: no assignee (BUTCHR_ASSIGNEE_TASK unset)"))).toBe(true);
  });

  // (d) no parent and no implements -> refuses. Story and Task get DIFFERENT wording:
  // a Story can genuinely parent to an Epic, a Task cannot parent to a Story in this project.
  // Both refusals also leave a trace in the daemon log before throwing.
  test("Story: no parent and no implements refuses with the generic Story/Task contract message, and audits the refusal", async () => {
    const { tools, calls, audits, conn } = rig();
    await expect(tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s" }, conn))
      .rejects.toThrow(/a Story implements an Epic and a Task implements a Story/);
    expect(calls.find(([n]) => n === "createIssue")).toBeUndefined();
    expect(audits.some((a) => a.includes("REFUSED: no implements target"))).toBe(true);
  });
  test("Task: no parent and no implements refuses with the Task-specific message (cannot parent to a Story), and audits the refusal", async () => {
    const { tools, calls, audits, conn } = rig();
    await expect(tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s" }, conn))
      .rejects.toThrow(/a Task cannot have a Story parent in this project/);
    expect(calls.find(([n]) => n === "createIssue")).toBeUndefined();
    expect(audits.some((a) => a.includes("REFUSED: no implements target"))).toBe(true);
  });

  // (e) implements given -> ops.linkIssues called from=new key, to=target, type Implements.
  test("implements given: ops.linkIssues called from=new key to=implements target", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", implements: "KAN-795" }, conn);
    const link = calls.find(([n]) => n === "linkIssues")!;
    expect(link[1]).toEqual(["KAN-999", "KAN-795", "Implements"]);
  });

  // (f) parent given, implements absent -> link created to the parent.
  test("parent given, implements absent: link created to the parent", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", parent: "KAN-794" }, conn);
    const link = calls.find(([n]) => n === "linkIssues")!;
    expect(link[1]).toEqual(["KAN-999", "KAN-794", "Implements"]);
  });

  // (g) implements AND parent both given and DIFFERENT -> implements wins for the link;
  // parent is still passed through to ops.createIssue as the Jira parent (membership vs routing).
  test("implements and parent both given and different: implements wins for the link, parent still reaches ops.createIssue", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", parent: "KAN-794", implements: "KAN-795" }, conn);
    const create = calls.find(([n]) => n === "createIssue")!;
    expect((create[1][0] as { parent?: string }).parent).toBe("KAN-794");
    const link = calls.find(([n]) => n === "linkIssues")!;
    expect(link[1]).toEqual(["KAN-999", "KAN-795", "Implements"]);
  });

  // (h) create OK + linkIssues REJECTS -> result still carries the new key and the link error; handler does not throw.
  test("create succeeds, link fails: result still carries the key and the link error; handler does not throw", async () => {
    const { tools, conn } = rig(roles, { linkIssues: async () => { throw new Error("boom"); } });
    const result = (await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794" }, conn)) as { key: string; implements: unknown };
    expect(result.key).toBe("KAN-999");
    expect(result.implements).toEqual({ ok: false, to: "KAN-794", error: "boom" });
  });

  // (i) opt-out implements: "none" -> no linkIssues call at all, role assignee still applied, audit says "orphan by request".
  test('opt-out implements: "none": no link call, role assignee still applied, audit line says "orphan by request"', async () => {
    const { tools, calls, audits, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "none" }, conn);
    expect(calls.find(([n]) => n === "linkIssues")).toBeUndefined();
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe(STORY_ID);
    expect(audits.some((a) => a.includes("orphan by request"))).toBe(true);
  });
  test('opt-out is accepted case-insensitively ("NONE")', async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", implements: "NONE" }, conn);
    expect(calls.find(([n]) => n === "linkIssues")).toBeUndefined();
  });
  test("silence is never the opt-out: omitting both implements and parent still refuses", async () => {
    const { tools, conn } = rig();
    await expect(tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s" }, conn)).rejects.toThrow();
  });

  // (j) ops.linkIssues resolving undefined (the real 201-empty-body case) -> reports the link as OK, not a failure.
  // On THIS path (unlike jira_link_issues) the op's resolved value is never returned to the caller — only a
  // REJECTION signals a link failure here, so a resolved `undefined` needs no KAN-764 substitution to read as ok:true.
  test("ops.linkIssues resolving undefined (a resolved promise, not a rejection) is reported as a successful link", async () => {
    const { tools, conn } = rig(roles, { linkIssues: async () => undefined });
    const result = (await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794" }, conn)) as { implements: unknown };
    expect(result.implements).toEqual({ ok: true, to: "KAN-794" });
  });

  // ops.createIssue's contract doesn't guarantee `key` is present — never call linkIssues with an undefined `from`.
  test("ops.createIssue resolving without a key: link is never attempted, result explains why, handler does not throw", async () => {
    const { tools, calls, conn } = rig(roles, { createIssue: async () => ({ ok: "createIssue" }) });
    const result = (await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "KAN-794" }, conn)) as { key?: string; implements: unknown };
    expect(result.key).toBeUndefined();
    expect(result.implements).toEqual({ ok: false, to: "KAN-794", error: "create response carried no issue key; link not attempted" });
    expect(calls.find(([n]) => n === "linkIssues")).toBeUndefined();
  });

  // (k) Epic unchanged: no role assignee applied, no target required, no link created, creates with neither parent nor implements.
  test("Epic: no role assignee applied, no target required, no link created, creates with neither parent nor implements", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Epic", summary: "s" }, conn);
    expect(calls.find(([n]) => n === "linkIssues")).toBeUndefined();
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBeUndefined();
  });
  test("Epic: explicit assignee still passes through unchanged", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Epic", summary: "s", assignee: "acct-epic" }, conn);
    expect((calls[0]![1][0] as { assignee?: string }).assignee).toBe("acct-epic");
  });

  // Audit line: type/parent, resolved target ("implements X" or "orphan by request"), resolved assignee (truncated)
  // — matching the exact wording from the ticket's examples.
  test("audit line for a Story with implements matches the ticket's example format", async () => {
    const { tools, audits, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", parent: "KAN-794", implements: "KAN-794" }, conn);
    expect(audits.some((a) => a.includes("create Story under KAN-794 implements KAN-794 → 712020:e160…"))).toBe(true);
  });
  test("audit line for a Task with implements matches the ticket's example format", async () => {
    const { tools, audits, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Task", summary: "s", parent: "KAN-794", implements: "KAN-795" }, conn);
    expect(audits.some((a) => a.includes("create Task under KAN-794 implements KAN-795 → 712020:619e…"))).toBe(true);
  });
  test("audit line for orphan-by-request matches the ticket's example format", async () => {
    const { tools, audits, conn } = rig();
    await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "none" }, conn);
    expect(audits.some((a) => a.includes("create Story under (none) orphan by request → 712020:e160…"))).toBe(true);
  });
});

describe("jira_set_priority result normalization (KAN-803)", () => {
  test("ops.setPriority resolving undefined (the real empty-204-body case) still produces a defined MCP result", async () => {
    const ops: AtlassianOps = {
      getIssue: async () => ({}), search: async () => ({}), addComment: async () => ({}),
      linkIssues: async () => ({}), transition: async () => ({}), createIssue: async () => ({ key: "KAN-1" }),
      setPriority: async () => undefined, assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const result = await tools.jira_set_priority!.handler({ key: "KAN-1", priority: "High" }, { headers: {} } as any);
    expect(result).toEqual({ ok: true, key: "KAN-1", priority: "High" });
  });
});

describe("confluence_update_page result normalization", () => {
  test("ops.updatePage resolving undefined still produces a defined MCP result (same orOk shape as the other write tools)", async () => {
    const ops: AtlassianOps = {
      getIssue: async () => ({}), search: async () => ({}), addComment: async () => ({}),
      linkIssues: async () => ({}), transition: async () => ({}), createIssue: async () => ({}),
      setPriority: async () => ({}), assign: async () => ({}), createPage: async () => ({}), getPage: async () => ({}),
      updatePage: async () => undefined, searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const result = await tools.confluence_update_page!.handler({ id: "10715137", body: "<p>x</p>" }, { headers: {} } as any);
    expect(result).toEqual({ ok: true, id: "10715137" });
  });
});

describe("confluence_search_pages", () => {
  function rig(opsOverrides: Partial<AtlassianOps> = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string, result: unknown = { results: [] }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
    const ops: AtlassianOps = {
      getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"),
      transition: rec("transition"), createIssue: rec("createIssue"), setPriority: rec("setPriority"),
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"),
      searchPages: rec("searchPages", { results: [{ content: { id: "10715137" }, title: "The captain's log convention", url: "/spaces/SD/pages/10715137" }] }),
      listSpaces: rec("listSpaces", { results: [{ id: "196612", key: "SD" }] }),
      ...fakeDocOps(),
      ...opsOverrides,
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const conn = { headers: {} } as any;
    return { tools, calls, conn };
  }

  test("refuses when neither titleContains nor cql is given", async () => {
    const { tools, conn } = rig();
    await expect(tools.confluence_search_pages!.handler({}, conn)).rejects.toThrow(/titleContains.*cql|cql.*titleContains/);
  });

  test("titleContains builds a title ~ CQL clause, quotes escaped, and maps hits to id/title/webui", async () => {
    const { tools, calls, conn } = rig();
    const result = await tools.confluence_search_pages!.handler({ titleContains: 'a "quoted" word' }, conn);
    const [, args] = calls.find(([n]) => n === "searchPages")!;
    expect(args[0]).toBe('title ~ "a \\"quoted\\" word"');
    expect(args[1]).toBe(25); // default limit
    expect(result).toEqual({ results: [{ id: "10715137", title: "The captain's log convention", webui: "/spaces/SD/pages/10715137" }] });
  });

  test("spaceKey given: appended directly as a space = clause, no listSpaces lookup", async () => {
    const { tools, calls, conn } = rig();
    await tools.confluence_search_pages!.handler({ titleContains: "log", spaceKey: "SD" }, conn);
    expect(calls.find(([n]) => n === "listSpaces")).toBeUndefined();
    const [, args] = calls.find(([n]) => n === "searchPages")!;
    expect(args[0]).toBe('title ~ "log" AND space = "SD"');
  });

  test("spaceId given (no spaceKey): resolved to a key via listSpaces before building the space clause", async () => {
    const { tools, calls, conn } = rig();
    await tools.confluence_search_pages!.handler({ titleContains: "log", spaceId: "196612" }, conn);
    expect(calls.find(([n]) => n === "listSpaces")).toBeDefined();
    const [, args] = calls.find(([n]) => n === "searchPages")!;
    expect(args[0]).toBe('title ~ "log" AND space = "SD"');
  });

  test("spaceId with no matching space: refuses with a clear message, never calls searchPages", async () => {
    const { tools, calls, conn } = rig();
    await expect(tools.confluence_search_pages!.handler({ titleContains: "log", spaceId: "999999" }, conn)).rejects.toThrow(/no space found with id 999999/);
    expect(calls.find(([n]) => n === "searchPages")).toBeUndefined();
  });

  test("raw cql is used as-is; titleContains/space scoping never applied alongside it", async () => {
    const { tools, calls, conn } = rig();
    await tools.confluence_search_pages!.handler({ cql: "type = page AND space = SD", titleContains: "ignored", spaceKey: "IGNORED" }, conn);
    const [, args] = calls.find(([n]) => n === "searchPages")!;
    expect(args[0]).toBe("type = page AND space = SD");
  });

  test("limit passes through to ops.searchPages", async () => {
    const { tools, calls, conn } = rig();
    await tools.confluence_search_pages!.handler({ titleContains: "log", limit: 5 }, conn);
    const [, args] = calls.find(([n]) => n === "searchPages")!;
    expect(args[1]).toBe(5);
  });
});

describe("confluence_create_page parentId", () => {
  test("parentId reaches ops.createPage when given; omitted when not", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string, result: unknown = {}) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
    const ops: AtlassianOps = {
      getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"),
      transition: rec("transition"), createIssue: rec("createIssue"), setPriority: rec("setPriority"),
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"), searchPages: rec("searchPages"), listSpaces: rec("listSpaces"),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const conn = { headers: {} } as any;
    await tools.confluence_create_page!.handler({ spaceId: "196612", title: "t", body: "<p/>", parentId: "196725" }, conn);
    await tools.confluence_create_page!.handler({ spaceId: "196612", title: "t2", body: "<p/>" }, conn);
    expect((calls[0]![1][0] as { parentId?: string }).parentId).toBe("196725");
    expect((calls[1]![1][0] as { parentId?: string }).parentId).toBeUndefined();
  });
});

describe("jira_assign (KAN-810)", () => {
  const STORY_ID = "712020:e160cf60-6480-44de-8554-af5b81c584e2";
  const TASK_ID = "712020:619ec5ec-2e92-492f-8979-91ccda318230";
  const roles = { story: STORY_ID, task: TASK_ID };

  function rig(customRoles: { story?: string; task?: string } = roles, opsOverrides: Partial<AtlassianOps> = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string, result: unknown = { ok: name }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
    const ops: AtlassianOps = {
      getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"),
      linkIssues: rec("linkIssues"), transition: rec("transition"),
      createIssue: rec("createIssue", { key: "KAN-999" }), setPriority: rec("setPriority"),
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"), searchPages: rec("searchPages"), listSpaces: rec("listSpaces"),
      ...fakeDocOps(),
      ...opsOverrides,
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), customRoles);
    const conn = { headers: { "x-issue": "KAN-7" } } as any;
    return { tools, calls, audits, conn };
  }

  test("accountId passthrough: a non-role string reaches ops.assign unchanged, and only the assignee field is touched", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_assign!.handler({ key: "KAN-1", assignee: "acct-explicit" }, conn);
    expect(calls).toEqual([["assign", ["KAN-1", "acct-explicit"]]]);
  });

  test('role resolution: "story" resolves through the roles map to its configured accountId', async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_assign!.handler({ key: "KAN-1", assignee: "story" }, conn);
    expect(calls).toEqual([["assign", ["KAN-1", STORY_ID]]]);
  });
  test('role resolution: "task" resolves through the roles map to its configured accountId', async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_assign!.handler({ key: "KAN-1", assignee: "task" }, conn);
    expect(calls).toEqual([["assign", ["KAN-1", TASK_ID]]]);
  });
  test("role resolution is case-insensitive", async () => {
    const { tools, calls, conn } = rig();
    await tools.jira_assign!.handler({ key: "KAN-1", assignee: "STORY" }, conn);
    expect(calls).toEqual([["assign", ["KAN-1", STORY_ID]]]);
  });

  test("unset role refuses, names the env var, does not call ops.assign, and audits the refusal", async () => {
    const { tools, calls, audits, conn } = rig({});
    await expect(tools.jira_assign!.handler({ key: "KAN-1", assignee: "story" }, conn))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_STORY/);
    expect(calls.find(([n]) => n === "assign")).toBeUndefined();
    expect(audits.some((a) => a.includes("REFUSED: no assignee (BUTCHR_ASSIGNEE_STORY unset)"))).toBe(true);
  });
  test("unset TASK role refuses and names BUTCHR_ASSIGNEE_TASK", async () => {
    const { tools, audits, conn } = rig({});
    await expect(tools.jira_assign!.handler({ key: "KAN-1", assignee: "task" }, conn))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_TASK/);
    expect(audits.some((a) => a.includes("REFUSED: no assignee (BUTCHR_ASSIGNEE_TASK unset)"))).toBe(true);
  });

  test("undefined-result guard: ops.assign resolving undefined (Jira's empty editIssue body) still produces a defined, ok:true MCP result", async () => {
    const { tools, conn } = rig(roles, { assign: async () => undefined });
    const result = await tools.jira_assign!.handler({ key: "KAN-1", assignee: "acct-x" }, conn);
    expect(result).toEqual({ ok: true, key: "KAN-1", assignee: "acct-x" });
  });

  test("audits every call, including a successful one, with the caller's issue", async () => {
    const { tools, audits, conn } = rig();
    await tools.jira_assign!.handler({ key: "KAN-1", assignee: "acct-x" }, conn);
    expect(audits.some((a) => a.includes("KAN-7") && a.includes("assign KAN-1 →"))).toBe(true);
  });
});

describe("get_doc / set_doc (BUTCHR-33): x-issue wiring", () => {
  // docs.ts's own logic (recursive creation, pagination, the race retry) is
  // covered exhaustively in test/unit/docs.test.ts — these tests only check
  // that the tool layer resolves the right key from `x-issue` and never from
  // an argument, and that set_doc's schema has no way to name another ticket.
  function customRig(opsOverrides: Partial<AtlassianOps> = {}) {
    const ops: AtlassianOps = {
      getIssue: async () => ({ self: "https://fake.atlassian.net/rest/api/3/issue/1", fields: { summary: "s", issuelinks: [] } }),
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({}), transition: async () => ({}),
      createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({ title: "t", body: { storage: { value: "b" } }, _links: {} }),
      updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
      ...opsOverrides,
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    return { tools };
  }

  test("set_doc's input schema has no `key` field at all", () => {
    const { tools } = customRig();
    expect(Object.keys(tools.set_doc!.input).sort()).toEqual(["body", "title"]);
  });

  test("get_doc() with no args resolves to the caller's OWN key from x-issue, never an argument", async () => {
    const seen: string[] = [];
    const { tools } = customRig({ getRemoteLink: async (key) => { seen.push(key); return null; } });
    await tools.get_doc!.handler({}, { headers: { "x-issue": "KAN-7" } } as any);
    expect(seen).toEqual(["KAN-7"]);
  });

  test("get_doc(key) reads the GIVEN ticket's doc, not the caller's", async () => {
    const seen: string[] = [];
    const { tools } = customRig({ getRemoteLink: async (key) => { seen.push(key); return null; } });
    await tools.get_doc!.handler({ key: "KAN-9" }, { headers: { "x-issue": "KAN-7" } } as any);
    expect(seen).toEqual(["KAN-9"]);
  });

  test("get_doc never creates: a miss returns { found: false } without ever calling createPageWithLabel", async () => {
    let createCalled = false;
    const { tools } = customRig({ createPageWithLabel: async () => { createCalled = true; return { id: "1", title: "t", url: "https://x/1" }; } });
    const result = await tools.get_doc!.handler({}, { headers: { "x-issue": "KAN-7" } } as any);
    expect(result).toEqual({ found: false });
    expect(createCalled).toBe(false);
  });

  test("get_doc refuses when the connection has no x-issue", async () => {
    const { tools } = customRig();
    await expect(tools.get_doc!.handler({}, { headers: {} } as any)).rejects.toThrow(/x-issue/);
  });

  test("set_doc always writes the CALLER's own doc from x-issue — no argument can target another ticket", async () => {
    const seen: string[] = [];
    const { tools } = customRig({ upsertRemoteLink: async (key: string) => { seen.push(key); return {}; } });
    // Two upserts land here: ensureDoc's own (step 5, on lazy creation) plus
    // set_doc's link-title refresh (the provisional title differs from "T") —
    // both must still target only the caller's own key, never an argument.
    await tools.set_doc!.handler({ body: "<p>x</p>", title: "T" }, { headers: { "x-issue": "KAN-7" } } as any);
    expect(seen).toEqual(["KAN-7", "KAN-7"]);
  });

  test("set_doc refuses when the connection has no x-issue", async () => {
    const { tools } = customRig();
    await expect(tools.set_doc!.handler({ body: "x" }, { headers: {} } as any)).rejects.toThrow(/x-issue/);
  });

  test("set_doc fires onWrite for the caller's own key (the remote-link upsert bumps its `updated`)", async () => {
    const writes: Array<[string[], string]> = [];
    const { tools } = (() => {
      const ops: AtlassianOps = {
        getIssue: async () => ({ self: "https://fake.atlassian.net/rest/api/3/issue/1", fields: { summary: "s", issuelinks: [] } }),
        search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({}), transition: async () => ({}),
        createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({}),
        createPage: async () => ({}), getPage: async () => ({ title: "T", body: { storage: { value: "x" } }, _links: {} }),
        updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
        ...fakeDocOps(),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
      };
      return { tools: atlassianTools(ops, () => {}, {}, (keys: readonly string[], writer: string) => writes.push([[...keys], writer])) };
    })();
    await tools.set_doc!.handler({ body: "<p>x</p>", title: "T" }, { headers: { "x-issue": "KAN-7" } } as any);
    expect(writes).toEqual([[["KAN-7"], "KAN-7"]]);
  });
});

describe("the ten relationship verbs (BUTCHR-35): wiring — x-issue, schema shape, audit, onWrite", () => {
  const TEN = ["new_worker", "start_worker", "shelve_worker", "adopt_worker", "finish_worker", "prioritize_worker", "tell_worker", "report_to_boss", "ask_boss", "submit_to_boss"] as const;

  /** Minimal args satisfying each verb's required schema, so every one below can be called uniformly for the no-x-issue sweep. */
  const MIN_ARGS: Record<(typeof TEN)[number], Record<string, unknown>> = {
    new_worker: { summary: "s", disposition: "start" },
    start_worker: { key: "KAN-9" },
    shelve_worker: { key: "KAN-9", reason: "r" },
    adopt_worker: { key: "KAN-9", disposition: "start" },
    finish_worker: { key: "KAN-9" },
    prioritize_worker: { key: "KAN-9", priority: "High" },
    tell_worker: { key: "KAN-9", text: "t" },
    report_to_boss: { text: "t" },
    ask_boss: { text: "t" },
    submit_to_boss: {},
  };

  function rigNoOp() {
    const ops: AtlassianOps = {
      getIssue: async () => ({ fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "To Do" }, issuelinks: [] } }),
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({}), transition: async () => ({}),
      createIssue: async () => ({ key: "KAN-999" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    return atlassianTools(ops, () => {}, { story: "acct-story", task: "acct-task" });
  }

  test("every one of the ten refuses a connection with no x-issue, in the get_doc/set_doc shape", async () => {
    const tools = rigNoOp();
    for (const name of TEN) {
      await expect(tools[name]!.handler(MIN_ARGS[name], { headers: {} } as any)).rejects.toThrow(/this connection has no x-issue/);
    }
  });

  test("report_to_boss / ask_boss have ONLY `text` — no key parameter is expressible", () => {
    const tools = rigNoOp();
    expect(Object.keys(tools.report_to_boss!.input).sort()).toEqual(["text"]);
    expect(Object.keys(tools.ask_boss!.input).sort()).toEqual(["text"]);
  });

  test("submit_to_boss takes NO arguments at all", () => {
    const tools = rigNoOp();
    expect(Object.keys(tools.submit_to_boss!.input)).toEqual([]);
  });

  test("new_worker's schema requires `disposition`; `reason` stays optional at the schema level (validated by relationship.ts instead)", () => {
    const tools = rigNoOp();
    expect(Object.keys(tools.new_worker!.input).sort()).toEqual(["description", "disposition", "priority", "reason", "summary"]);
  });

  test("start_worker / shelve_worker / finish_worker / prioritize_worker / tell_worker audit lines name the verb and the target key", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string, result: unknown = { ok: name }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
    const ops: AtlassianOps = {
      getIssue: async () => ({ fields: { issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "To Do" }, issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-7" } }] } }),
      search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"), transition: rec("transition"),
      createIssue: rec("createIssue"), setPriority: rec("setPriority"), assign: rec("assign"),
      createPage: rec("createPage"), getPage: rec("getPage"), updatePage: rec("updatePage"), searchPages: rec("searchPages"), listSpaces: rec("listSpaces"),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l));
    const conn = { headers: { "x-issue": "KAN-7" } } as any;
    await tools.start_worker!.handler({ key: "KAN-9" }, conn);
    await tools.shelve_worker!.handler({ key: "KAN-9", reason: "later" }, conn);
    await tools.finish_worker!.handler({ key: "KAN-9" }, conn);
    await tools.prioritize_worker!.handler({ key: "KAN-9", priority: "High" }, conn);
    await tools.tell_worker!.handler({ key: "KAN-9", text: "hi" }, conn);
    expect(audits.some((a) => a.includes("start_worker KAN-9"))).toBe(true);
    expect(audits.some((a) => a.includes("shelve_worker KAN-9"))).toBe(true);
    expect(audits.some((a) => a.includes("finish_worker KAN-9"))).toBe(true);
    expect(audits.some((a) => a.includes("prioritize_worker KAN-9 → High"))).toBe(true);
    expect(audits.some((a) => a.includes("tell_worker KAN-9"))).toBe(true);
    expect(audits.every((a) => a.includes("KAN-7"))).toBe(true);
  });

  test("report_to_boss / ask_boss / submit_to_boss fire onWrite for the CALLER's own key, never an argument", async () => {
    const ops: AtlassianOps = {
      getIssue: async () => ({ fields: { issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } }),
      search: async () => ({}), addComment: async () => ({ ok: true }), linkIssues: async () => ({}), transition: async () => ({ ok: true }),
      createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, () => {}, {}, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-7" } } as any;
    await tools.report_to_boss!.handler({ text: "a" }, conn);
    await tools.ask_boss!.handler({ text: "b" }, conn);
    await tools.submit_to_boss!.handler({}, conn);
    expect(writes).toEqual([[["KAN-7"], "KAN-7"], [["KAN-7"], "KAN-7"], [["KAN-7"], "KAN-7"]]);
  });

  test("new_worker end-to-end through the tool layer: disposition/priority reach relationship.ts, and onWrite fires for both the new key and the caller", async () => {
    let created: string | undefined;
    const ops: AtlassianOps = {
      getIssue: async (key: string) => {
        if (key === "KAN-1") return { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } };
        // ensureDoc reads the NEW ticket's own issuelinks to find its boss chain; give it one back to KAN-1.
        return { fields: { issuetype: { name: "Story" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }] } };
      },
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async (p) => { created = "KAN-42"; expect(p.priority).toBe("High"); return { key: created }; },
      setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, () => {}, { story: "acct-story" }, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.new_worker!.handler({ summary: "s", priority: "High", disposition: "start" }, conn)) as { key: string };
    expect(result.key).toBe("KAN-42");
    expect(created).toBe("KAN-42");
    expect(writes).toEqual([[["KAN-42", "KAN-1"], "KAN-1"]]);
  });

  test("adopt_worker end-to-end through the tool layer: disposition reaches relationship.ts, onWrite fires for both the adopted key and the caller", async () => {
    const ops: AtlassianOps = {
      getIssue: async (key: string) => {
        if (key === "KAN-1") return { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } };
        return { fields: { issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "To Do" }, issuelinks: [] } }; // orphan
      },
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({ ok: true }),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, () => {}, { task: "acct-task" }, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.adopt_worker!.handler({ key: "KAN-9", disposition: "start" }, conn)) as { key: string; alreadyAdopted: boolean };
    expect(result.key).toBe("KAN-9");
    expect(result.alreadyAdopted).toBe(false);
    expect(writes).toEqual([[["KAN-9", "KAN-1"], "KAN-1"]]);
  });

  // BUTCHR-110/S1, exercised at the FULL TOOL-WIRING LEVEL (through
  // atlassianTools/defs.ts), not just relationship.ts directly — this is
  // the only place the "IDENTITY COLLISION" audit line (src/tools/defs.ts)
  // can be observed at all, since relationship.ts itself never writes to
  // the daemon's audit log.
  test("new_worker end-to-end: a caller whose own assignee equals the child's role produces identityCollision in the result, a comment on the new ticket, AND an IDENTITY COLLISION audit line", async () => {
    let commented: { key: string; text: string } | undefined;
    const ops: AtlassianOps = {
      getIssue: async (key: string) => {
        if (key === "KAN-1") return { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, assignee: { accountId: "acct-story" }, issuelinks: [] } };
        return { fields: { issuetype: { name: "Story" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }] } };
      },
      search: async () => ({}),
      addComment: async (key: string, text: string) => { commented = { key, text }; return { ok: true }; },
      linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }),
      setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: "test-account" }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), { story: "acct-story", task: "acct-task" });
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.new_worker!.handler({ summary: "s", disposition: "start" }, conn)) as { key: string; identityCollision?: string };
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_EPIC");
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_STORY");
    // THE ACTUAL RETURNED TOOL RESULT — pasted verbatim in the PR, per this ticket's own "before you run a check" requirement.
    console.log("new_worker identityCollision (result field):", result.identityCollision);
    expect(commented?.key).toBe("KAN-42");
    expect(commented?.text).toStartWith("[KAN-1]");
    console.log("new_worker identityCollision (ticket comment):", commented?.text);
    const auditLine = audits.find((l) => l.includes("IDENTITY COLLISION"));
    expect(auditLine).toBeDefined();
    expect(auditLine).toContain("new_worker KAN-42 IDENTITY COLLISION:");
    console.log("new_worker identityCollision (audit line):", auditLine);
  });

  test("new_worker end-to-end: NO collision when the caller's own assignee differs from the child's role — no identityCollision, no comment, no audit line", async () => {
    let commentCalls = 0;
    const ops: AtlassianOps = {
      getIssue: async (key: string) => {
        if (key === "KAN-1") return { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, assignee: { accountId: "some-other-human" }, issuelinks: [] } };
        return { fields: { issuetype: { name: "Story" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }] } };
      },
      search: async () => ({}),
      addComment: async () => { commentCalls++; return { ok: true }; },
      linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }),
      setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: "test-account" }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), { story: "acct-story", task: "acct-task" });
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.new_worker!.handler({ summary: "s", disposition: "start" }, conn)) as { identityCollision?: string };
    expect(result).not.toHaveProperty("identityCollision");
    expect(commentCalls).toBe(0);
    expect(audits.some((l) => l.includes("IDENTITY COLLISION"))).toBe(false);
  });

  test("new_worker's description does not claim atomicity, and states the ordering guarantee / convergent-doc / rollback shape (BUTCHR-35 review criterion: judge the description, not just the code)", () => {
    const tools = rigNoOp();
    const d = tools.new_worker!.description;
    expect(d).not.toMatch(/\batomic\b/i);
    expect(d).not.toMatch(/leaves nothing/i);
    expect(d).toMatch(/GUARANTEES/);
    expect(d).toMatch(/set_doc/);
    expect(d).toMatch(/rolled back|ROLLED BACK|delete the ticket/i);
  });
});

describe("file_where_it_belongs (BUTCHR-37): wiring — x-issue, schema shape, audit, onWrite", () => {
  function rigOrphan(roles: { story?: string; task?: string } = { story: "acct-story", task: "acct-task" }) {
    const ops: AtlassianOps = {
      getIssue: async (key: string) =>
        key === "KAN-1"
          ? { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } }
          : { fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } },
      search: async () => ({}), addComment: async () => ({ ok: true }), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    return { ops, tools: atlassianTools(ops, () => {}, roles) };
  }

  test("refuses a connection with no x-issue, in the get_doc/set_doc shape", async () => {
    const { tools } = rigOrphan();
    await expect(tools.file_where_it_belongs!.handler({ summary: "s", issuetype: "Task", destination: "KAN-1" }, { headers: {} } as any))
      .rejects.toThrow(/this connection has no x-issue/);
  });

  test("schema: summary/issuetype/destination required, description/priority optional, and NO disposition parameter at all", () => {
    const { tools } = rigOrphan();
    expect(Object.keys(tools.file_where_it_belongs!.input).sort()).toEqual(["description", "destination", "issuetype", "priority", "summary"]);
  });

  test("end-to-end through the tool layer: destination reaches relationship.ts, onWrite fires for the new key and the notice target, audit line names the verb and issuetype", async () => {
    const writes: Array<[string[], string]> = [];
    const audits: string[] = [];
    const ops: AtlassianOps = {
      getIssue: async () => ({ fields: { issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" }, issuelinks: [] } }),
      search: async () => ({}), addComment: async () => ({ ok: true }), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, (l) => audits.push(l), { task: "acct-task" }, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.file_where_it_belongs!.handler({ summary: "s", issuetype: "Task", destination: "KAN-1" }, conn)) as { key: string; noticeTarget: string };
    expect(result.key).toBe("KAN-42");
    expect(result.noticeTarget).toBe("KAN-1");
    expect(writes).toEqual([[["KAN-42", "KAN-1"], "KAN-1"]]);
    expect(audits.some((a) => a.includes('file_where_it_belongs issuetype=Task destination="KAN-1"'))).toBe(true);
  });

  test("the description names both destination shapes, the no-disposition rationale, and NEVER claims to be the only orphan route (jira_create_issue's implements:\"none\" still works)", () => {
    const { tools } = rigOrphan();
    const d = tools.file_where_it_belongs!.description;
    expect(d).toMatch(/EXISTING EPIC KEY/);
    expect(d).toMatch(/brand-new epic/);
    expect(d).toMatch(/NO DISPOSITION/);
    expect(d).toMatch(/CASE B CREATES NO LINK/);
    expect(d).toMatch(/file_for_another_boss/); // the design-history sentence, per BUTCHR-29's own instruction
  });

  test("jira_create_issue's description no longer claims to be the ONLY orphan route, but implements:\"none\" behavior is untouched", async () => {
    const { tools, ops } = rigOrphan();
    expect(tools.jira_create_issue!.description).toMatch(/file_where_it_belongs/);
    expect(tools.jira_create_issue!.description).not.toMatch(/ONLY way to file/);
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.jira_create_issue!.handler({ projectKey: "KAN", issuetype: "Story", summary: "s", implements: "none", assignee: "acct-x" }, conn)) as { key?: string };
    expect(result.key).toBe("KAN-42");
    void ops;
  });
});

describe("correct_worker (BUTCHR-60): wiring — x-issue, schema shape, audit, onWrite", () => {
  function rigWorker(roles: { story?: string; task?: string } = { story: "acct-story", task: "acct-task" }) {
    const ops: AtlassianOps = {
      getIssue: async () => ({
        fields: {
          issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "In Progress" },
          issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }],
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old description" }] }] },
          summary: "old summary",
        },
      }),
      search: async () => ({}), addComment: async () => ({ ok: true }), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    return { ops, tools: atlassianTools(ops, () => {}, roles) };
  }

  test("refuses a connection with no x-issue, in the get_doc/set_doc shape", async () => {
    const { tools } = rigWorker();
    await expect(tools.correct_worker!.handler({ key: "KAN-9", description: "new", why: "was wrong" }, { headers: {} } as any)).rejects.toThrow(/this connection has no x-issue/);
  });

  test("schema: key/why required, description/summary optional", () => {
    const { tools } = rigWorker();
    expect(Object.keys(tools.correct_worker!.input).sort()).toEqual(["description", "key", "summary", "why"]);
  });

  test("end-to-end through the tool layer: the archive comment is posted BEFORE correctText, onWrite fires for the WORKER key only (caller as writer — never the caller's own key), audit line names the verb and which fields were touched", async () => {
    const writes: Array<[string[], string]> = [];
    const audits: string[] = [];
    const calls: string[] = [];
    const ops: AtlassianOps = {
      getIssue: async () => ({
        fields: {
          issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "In Progress" },
          issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }],
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old description" }] }] },
          summary: "old summary",
        },
      }),
      search: async () => ({}),
      addComment: async () => { calls.push("addComment"); return { ok: true }; },
      linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps({ correctText: async () => { calls.push("correctText"); return { ok: true }; } }),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, (l) => audits.push(l), {}, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.correct_worker!.handler({ key: "KAN-9", description: "new description", why: "was stale" }, conn)) as {
      key: string; correctedDescription: boolean; correctedSummary: boolean; message: string;
    };
    expect(calls).toEqual(["addComment", "correctText"]); // archive BEFORE edit — the ordering the whole verb is built to guarantee
    expect(result.key).toBe("KAN-9");
    expect(result.correctedDescription).toBe(true);
    expect(result.correctedSummary).toBe(false);
    expect(writes).toEqual([[["KAN-9"], "KAN-1"]]); // the worker key only, caller as writer
    expect(audits.some((a) => a.includes('correct_worker KAN-9 description=true summary=false why="was stale"'))).toBe(true);
  });

  test("a supplied `description: \"\"` (clearing it — the BUTCHR-51 shape) reaches correctText and is NOT silently dropped as \"neither field given\" (regression: BUTCHR-60 review found this handler used truthy checks where every other layer in the diff uses `!== undefined`)", async () => {
    const calls: Array<[string, unknown]> = [];
    const ops: AtlassianOps = {
      getIssue: async () => ({
        fields: {
          issuetype: { name: "Task" }, project: { key: "KAN" }, status: { name: "In Progress" },
          issuelinks: [{ type: { name: "Implements" }, inwardIssue: { key: "KAN-1" } }],
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "malformed junk" }] }] },
          summary: "old summary",
        },
      }),
      search: async () => ({}), addComment: async () => ({ ok: true }), linkIssues: async () => ({ ok: true }), transition: async () => ({ ok: true }),
      createIssue: async () => ({ key: "KAN-42" }), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps({ correctText: async (key, p) => { calls.push([key, p]); return { ok: true }; } }),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const audits: string[] = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), {});
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.correct_worker!.handler(
      { key: "KAN-9", description: "", why: "description was structurally malformed junk; clearing it" },
      conn,
    )) as { correctedDescription: boolean; correctedSummary: boolean };
    expect(calls).toEqual([["KAN-9", { description: "" }]]); // correctText WAS called, with the empty string, not skipped
    expect(result.correctedDescription).toBe(true);
    expect(result.correctedSummary).toBe(false);
    expect(audits.some((a) => a.includes("correct_worker KAN-9 description=true summary=false"))).toBe(true);
  });

  test("the description states both review-mandated limitations up front (the epic-ownership wording — a project caller CAN correct its own epics, self-correction still refused at every tier, WITH the named Jira-UI recourse — and the summary-snapshot caveat), the self-refusal rationale, the archive marker, and both legitimate use cases (correction AND a late-arriving requirement)", () => {
    const { tools } = rigWorker();
    const d = tools.correct_worker!.description;
    expect(d).toMatch(/a project agent CAN correct one of its own epics' descriptions/); // BUTCHR-88: the corrected claim — a project caller IS an accepted owner of its own epics
    expect(d).not.toMatch(/no AGENT can ever correct/); // the retracted false claim must not reappear verbatim
    expect(d).not.toMatch(/epic has no boss/i); // the retracted false premise must not reappear either, under any casing
    expect(d).toMatch(/a person editing it directly in the Jira UI/); // the named recourse — half 1 without half 2 is the failure mode this ticket exists to fix
    expect(d).toMatch(/SNAPSHOTTED/);
    expect(d).toMatch(/launder a failure into a success/);
    expect(d).toMatch(/\[correction\]/);
    expect(d).toMatch(/LATE-ARRIVING REQUIREMENT/); // the additive use case — `why` is not only "what was wrong"
    expect(d).not.toMatch(/one line saying what was wrong/);
  });
});

describe("finish_without_a_boss (BUTCHR-39): wiring — x-issue, schema shape, audit, refusal, onWrite", () => {
  function rigWithBoss(bossKey: string | undefined) {
    const ops: AtlassianOps = {
      getIssue: async () => ({
        fields: {
          issuetype: { name: "Epic" }, project: { key: "KAN" }, status: { name: "In Progress" },
          issuelinks: bossKey ? [{ type: { name: "Implements" }, inwardIssue: { key: bossKey } }] : [],
        },
      }),
      // transition resolves undefined, matching Jira's real empty-201-body case (KAN-764) —
      // exercises orOk's fallback rather than masking it behind a truthy fake result.
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({}), transition: async () => undefined,
      createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
    commentOnPage: async () => ({ ok: true }),
    getPageComments: async () => ({ results: [] }),
    searchProjects: async () => ({ values: [] }),
    getMyself: async () => ({ accountId: 'test-account' }),
    setProjectProperty: async () => ({ ok: true }),
    getPageVersions: async () => ({}),
    getIssueComments: async () => ({ results: [] }),
    getProjectPropertyOrNull: async () => null,
    };
    return ops;
  }

  test("takes NO arguments at all, same shape as submit_to_boss", () => {
    const tools = atlassianTools(rigWithBoss(undefined), () => {});
    expect(Object.keys(tools.finish_without_a_boss!.input)).toEqual([]);
  });

  test("refuses a connection with no x-issue, in the get_doc/set_doc shape", async () => {
    const tools = atlassianTools(rigWithBoss(undefined), () => {});
    await expect(tools.finish_without_a_boss!.handler({}, { headers: {} } as any)).rejects.toThrow(/this connection has no x-issue/);
  });

  test("THE LOAD-BEARING TEST: refuses a caller that HAS a boss, with a message that teaches, and never transitions it", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const ops = rigWithBoss("KAN-1");
    const spied: AtlassianOps = { ...ops, transition: async (...a) => { calls.push(["transition", a]); return ops.transition(...a); } };
    const tools = atlassianTools(spied, () => {});
    const conn = { headers: { "x-issue": "KAN-9" } } as any;
    await expect(tools.finish_without_a_boss!.handler({}, conn)).rejects.toThrow(/has a boss \(KAN-1\)/);
    await expect(tools.finish_without_a_boss!.handler({}, conn)).rejects.toThrow(/submit_to_boss/);
    await expect(tools.finish_without_a_boss!.handler({}, conn)).rejects.toThrow(/finish_worker/);
    expect(calls.length).toBe(0); // never even attempted the transition
  });

  test("the happy path: a bossless caller reaches Done, audits, and fires onWrite for its OWN key", async () => {
    const ops = rigWithBoss(undefined);
    const audits: string[] = [];
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, (l) => audits.push(l), {}, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = await tools.finish_without_a_boss!.handler({}, conn);
    expect(result).toEqual({ ok: true, key: "KAN-1", status: "Done" });
    expect(audits.some((a) => a.includes("finish_without_a_boss") && a.includes("KAN-1"))).toBe(true);
    expect(writes).toEqual([[["KAN-1"], "KAN-1"]]);
  });
});

describe("BUTCHR-71: a PROJECT-keyed caller (x-issue: \"BUTCHR\", no hyphen) across the tool-registration layer", () => {
  /**
   * A project-shaped world: "BUTCHR" is the project key, "BUTCHR-9" an Epic
   * that is its member (no Implements link — see src/tools/relationship.ts).
   * `pages` seeds the project's root doc at id "1", matching `fakeDocOps`'s
   * default `rootDoc.id`.
   */
  function projectRig(rolesOverride: { story?: string; task?: string; epic?: string } = { story: "acct-story", task: "acct-task", epic: "acct-epic" }) {
    const epicIssue = { status: "To Do", labels: [] as string[], assignee: undefined as string | undefined };
    const pageComments: Array<{ pageId: string; body: string }> = [];
    const jiraComments: Array<{ key: string; text: string }> = [];
    const ops: AtlassianOps = {
      getIssue: async (key: string) => {
        if (key === "BUTCHR-9") {
          return { fields: { issuetype: { name: "Epic" }, project: { key: "BUTCHR" }, status: { name: epicIssue.status }, labels: epicIssue.labels, assignee: epicIssue.assignee ? { accountId: epicIssue.assignee } : null, issuelinks: [] } };
        }
        return { fields: { issuetype: { name: "Story" }, project: { key: "BUTCHR" }, status: { name: "To Do" }, labels: [], issuelinks: [] } };
      },
      search: async () => ({}),
      addComment: async (key: string, text: string) => { jiraComments.push({ key, text }); return { ok: true }; },
      linkIssues: async () => ({ ok: true }),
      transition: async (_key: string, status: string) => { epicIssue.status = status; return { ok: true }; },
      createIssue: async (p: { assignee?: string; labels?: string[] }) => { epicIssue.assignee = p.assignee; if (p.labels) epicIssue.labels = [...p.labels]; return { key: "BUTCHR-9" }; },
      setPriority: async () => ({ ok: true }),
      assign: async (_key: string, accountId: string) => { epicIssue.assignee = accountId; return { ok: true }; },
      createPage: async () => ({}),
      getPage: async (id: string) => ({ title: "BUTCHR — product brief", body: { storage: { value: "<p>hi</p>" } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } }),
      updatePage: async () => ({ ok: true }),
      searchPages: async () => ({ results: [] }),
      listSpaces: async () => ({}),
      ...fakeDocOps({ getProjectProperty: async () => ({ space: { key: "BUTCHR" }, rootDoc: { id: "1" } }) }),
      commentOnPage: async (pageId: string, body: string) => { pageComments.push({ pageId, body }); return { ok: true }; },
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {}, rolesOverride as any);
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    return { tools, conn, epicIssue, pageComments, jiraComments };
  }

  test("get_doc() resolves to the PROJECT's root doc, not an ensureDoc-created page", async () => {
    const { tools, conn } = projectRig();
    const result = await tools.get_doc!.handler({}, conn);
    expect(result).toEqual({ found: true, id: "1", url: expect.any(String), title: "BUTCHR — product brief", body: "<p>hi</p>" });
  });

  test("set_doc() replaces the PROJECT's root doc, title optional", async () => {
    const { tools, conn } = projectRig();
    const result = await tools.set_doc!.handler({ body: "<p>new</p>" }, conn);
    expect((result as any).id).toBe("1");
    expect((result as any).body).toBe("<p>new</p>");
  });

  test("new_worker creates an EPIC, member of BUTCHR, no implements field, staffed by roles.epic", async () => {
    const { tools, conn, epicIssue } = projectRig();
    const result = (await tools.new_worker!.handler({ summary: "s", disposition: "start" }, conn)) as any;
    expect(result.key).toBe("BUTCHR-9");
    expect(result.member).toBe("BUTCHR");
    expect(result.implements).toBeUndefined();
    expect(epicIssue.assignee).toBe("acct-epic");
    expect(epicIssue.status).toBe("In Progress");
  });

  test("new_worker refuses when roles.epic is unset, naming BUTCHR_ASSIGNEE_EPIC — never falls back to roles.story/roles.task", async () => {
    const { tools, conn } = projectRig({ story: "acct-story", task: "acct-task" }); // epic omitted
    await expect(tools.new_worker!.handler({ summary: "s", disposition: "start" }, conn)).rejects.toThrow(/BUTCHR_ASSIGNEE_EPIC/);
  });

  test("finish_worker / tell_worker succeed on the epic that is a member of BUTCHR", async () => {
    const { tools, conn, epicIssue, jiraComments } = projectRig();
    epicIssue.status = "In Progress";
    await tools.finish_worker!.handler({ key: "BUTCHR-9" }, conn);
    expect(epicIssue.status).toBe("Done");
    await tools.tell_worker!.handler({ key: "BUTCHR-9", text: "[review] APPROVED https://x/1 @ deadbeef" }, conn);
    expect(jiraComments.some((c) => c.key === "BUTCHR-9" && c.text.includes("[review] APPROVED"))).toBe(true);
  });

  test("report_to_boss / ask_boss are ALLOWED for a project caller — post on the root doc, never refused (BUTCHR-71 spec correction)", async () => {
    const { tools, conn, pageComments } = projectRig();
    await tools.report_to_boss!.handler({ text: "status update" }, conn);
    await tools.ask_boss!.handler({ text: "which way?" }, conn);
    expect(pageComments.length).toBe(2);
    expect(pageComments[0]!.pageId).toBe("1");
    expect(pageComments[0]!.body).toContain("[BUTCHR] status update");
    expect(pageComments[1]!.body).toContain("[ask]");
  });

  test("submit_to_boss REFUSES a project caller, naming why", async () => {
    const { tools, conn } = projectRig();
    await expect(tools.submit_to_boss!.handler({}, conn)).rejects.toThrow(/refusing a project caller/);
  });

  test("finish_without_a_boss REFUSES a project caller at the gate — WITHOUT ever calling relationship.ts's finishWithoutABoss (its own ops.getIssue(\"BUTCHR\") is never even attempted)", async () => {
    let getIssueCalls = 0;
    const ops: AtlassianOps = {
      getIssue: async () => { getIssueCalls++; return { fields: {} }; },
      search: async () => ({}), addComment: async () => ({}), linkIssues: async () => ({}), transition: async () => ({}),
      createIssue: async () => ({}), setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), updatePage: async () => ({}), searchPages: async () => ({}), listSpaces: async () => ({}),
      ...fakeDocOps(),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: 'test-account' }),
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
      getIssueComments: async () => ({ results: [] }),
      getProjectPropertyOrNull: async () => null,
    };
    const tools = atlassianTools(ops, () => {});
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    await expect(tools.finish_without_a_boss!.handler({}, conn)).rejects.toThrow(/refusing a project caller/);
    expect(getIssueCalls).toBe(0); // the gate fired before relationship.ts's own finishWithoutABoss ever ran
  });

  test("file_where_it_belongs REFUSES a project caller, naming why (no coherent case-B bottom)", async () => {
    const { tools, conn } = projectRig();
    await expect(tools.file_where_it_belongs!.handler({ summary: "s", issuetype: "Task", destination: "BUTCHR-9" }, conn)).rejects.toThrow(/refusing a project caller/);
  });
});

// BUTCHR-81's own scope addition: check_in, the project agent's last act
// before exiting (watermark checkpoint). Failure conditions stated first,
// per test.
describe("check_in (BUTCHR-67/BUTCHR-81: the project agent's own watermark checkpoint)", () => {
  function checkInRig(opts: {
    epicsInReview?: Array<{ key: string }>;
    epicComments?: Record<string, Array<{ id: string }>>;
    rootDocComments?: Array<{ id: string; body: string }>;
    rootDocVersion?: number;
  } = {}) {
    const properties = new Map<string, unknown>([["BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "1" } }]]);
    const setPropertyCalls: unknown[] = [];
    const searchCalls: string[] = [];
    const getIssueCommentsCalls: string[] = [];
    const ops: AtlassianOps = {
      getIssue: async () => ({ ok: true }),
      getIssueComments: async (key: string) => {
        getIssueCommentsCalls.push(key);
        return { results: opts.epicComments?.[key] ?? [] };
      },
      search: async (jql: string) => {
        searchCalls.push(jql);
        return { issues: (opts.epicsInReview ?? []).map((e) => ({ key: e.key })) };
      },
      addComment: async () => ({ ok: true }),
      linkIssues: async () => ({ ok: true }),
      transition: async () => ({ ok: true }),
      createIssue: async () => ({ ok: true }),
      setPriority: async () => ({ ok: true }),
      assign: async () => ({ ok: true }),
      createPage: async () => ({ ok: true }),
      getPage: async () => ({ ok: true }),
      updatePage: async () => ({ ok: true }),
      searchPages: async () => ({ results: [] }),
      listSpaces: async () => ({ ok: true }),
      getRemoteLink: async () => null,
      upsertRemoteLink: async () => ({ ok: true }),
      getChildPages: async () => ({ results: [] }),
      getPageLabels: async () => [],
      createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
      addLabels: async () => ({ ok: true }),
      removeLabels: async () => ({ ok: true }),
      deleteIssue: async () => ({ ok: true }),
      correctText: async () => ({ ok: true }),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: opts.rootDocComments ?? [] }),
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: "test-account" }),
      getProjectProperty: async (key: string) => {
        const p = properties.get(key);
        if (!p) throw new Error(`no property for ${key}`);
        return p;
      },
      getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
      setProjectProperty: async (key: string, _propertyKey: string, value: unknown) => {
        setPropertyCalls.push(value);
        properties.set(key, value);
        return { ok: true };
      },
      getPageVersions: async () => ({ "1": opts.rootDocVersion ?? 3 }),
    };
    const tools = atlassianTools(ops, () => {});
    return { tools, properties, setPropertyCalls, searchCalls, getIssueCommentsCalls };
  }

  test("refuses an ISSUE caller — an issue never sleeps and has no watermark to advance", async () => {
    const { tools } = checkInRig();
    const conn = { headers: { "x-issue": "BUTCHR-1" } } as any;
    await expect(tools.check_in!.handler({}, conn)).rejects.toThrow(/refusing an issue caller/);
  });

  test("refuses a connection with no x-issue", async () => {
    const { tools } = checkInRig();
    const conn = { headers: {} } as any;
    await expect(tools.check_in!.handler({}, conn)).rejects.toThrow(/refusing/);
  });

  test("with nothing in review: watermarks version and comment, and REPLACES epics with {} (pruning any stale entries)", async () => {
    const { tools, properties } = checkInRig({ rootDocVersion: 5, rootDocComments: [{ id: "99", body: "hi" }] });
    // Seed a stale epic entry, as if watermarked during a PRIOR review episode.
    properties.set("BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "1" }, wake: { version: 1, comment: null, epics: { "BUTCHR-9": "50" } } });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = await tools.check_in!.handler({}, conn);
    expect(result).toEqual({ ok: true, key: "BUTCHR", version: 5, comment: "99", epics: {} });
    expect((properties.get("BUTCHR") as any).wake).toEqual({ version: 5, comment: "99", epics: {} }); // BUTCHR-9 pruned
  });

  // BUTCHR-81 (found at review): check_in must read epic comments via the
  // SAME reader discovery uses (getIssueComments — newest-first, capped),
  // never getIssue's embedded fields.comment block (measured ascending/
  // oldest-first with an unconfirmed cap) — otherwise the two readers could
  // disagree on "newest" and the watermark would never catch up.
  test("with an epic in review: fetches ITS comments via getIssueComments (the SAME reader discovery uses, not getIssue's embedded block), and watermarks it", async () => {
    const { tools, properties, getIssueCommentsCalls } = checkInRig({
      epicsInReview: [{ key: "BUTCHR-9" }],
      epicComments: { "BUTCHR-9": [{ id: "101" }, { id: "202" }] },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = (await tools.check_in!.handler({}, conn)) as { epics: Record<string, string> };
    expect(result.epics).toEqual({ "BUTCHR-9": "202" }); // newest by numeric value
    expect(getIssueCommentsCalls).toEqual(["BUTCHR-9"]);
    expect((properties.get("BUTCHR") as any).wake.epics).toEqual({ "BUTCHR-9": "202" });
  });

  test("no epics in review at all -> zero getIssueComments calls (the usual case)", async () => {
    const { tools, getIssueCommentsCalls } = checkInRig({ epicsInReview: [] });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    await tools.check_in!.handler({}, conn);
    expect(getIssueCommentsCalls).toEqual([]);
  });

  test("no root-doc comments yet -> comment watermark stays unadvanced (null), not clobbered to null over a real prior value", async () => {
    const { tools, properties } = checkInRig({ rootDocComments: [] });
    properties.set("BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: "1" }, wake: { version: 1, comment: "42", epics: {} } });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    await tools.check_in!.handler({}, conn);
    expect((properties.get("BUTCHR") as any).wake.comment).toBe("42"); // untouched — omitted from the patch, not overwritten with null
  });
});

// BUTCHR-109: get_doc_comments, the inbound half of "a project is talked to
// by commenting on its root doc" (check_in above is the OUTBOUND half's
// watermark, not a reply channel). Failure conditions stated first, per
// test, same discipline as check_in's own block.
describe('get_doc_comments (BUTCHR-107/BUTCHR-109: "a project is talked to by commenting on its root doc" — the inbound half)', () => {
  // Two DISTINCT pages, each with its own distinct comment, keyed by pageId —
  // this is what makes the control test below meaningful: a reader that
  // ignored the `id` argument (the batch-endpoint bug BUTCHR-107 names by
  // name) would return BOTH pages' comments no matter which page was asked
  // for, and this rig is shaped so that mistake is visible in the assertion,
  // not hidden by both pages coincidentally holding the same text.
  function docCommentsRig(byPage: Record<string, Array<{ id: string; body: string; author?: string }>>, opts: { rootDocId?: string } = {}) {
    const properties = new Map<string, unknown>([["BUTCHR", { space: { key: "BUTCHR" }, rootDoc: { id: opts.rootDocId ?? "1" } }]]);
    const getPageCommentsCalls: string[] = [];
    const ops: AtlassianOps = {
      getIssue: async () => ({ ok: true }),
      getIssueComments: async () => ({ results: [] }),
      search: async () => ({ issues: [] }),
      addComment: async () => ({ ok: true }),
      linkIssues: async () => ({ ok: true }),
      transition: async () => ({ ok: true }),
      createIssue: async () => ({ ok: true }),
      setPriority: async () => ({ ok: true }),
      assign: async () => ({ ok: true }),
      createPage: async () => ({ ok: true }),
      getPage: async () => ({ ok: true }),
      updatePage: async () => ({ ok: true }),
      searchPages: async () => ({ results: [] }),
      listSpaces: async () => ({ ok: true }),
      getRemoteLink: async () => null,
      upsertRemoteLink: async () => ({ ok: true }),
      getChildPages: async () => ({ results: [] }),
      getPageLabels: async () => [],
      createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
      addLabels: async () => ({ ok: true }),
      removeLabels: async () => ({ ok: true }),
      deleteIssue: async () => ({ ok: true }),
      correctText: async () => ({ ok: true }),
      commentOnPage: async () => ({ ok: true }),
      // The reader under test: PER-PAGE, keyed strictly by the `pageId`
      // argument — never the batch `?id=A&id=B` shape this ticket forbids
      // (see getPageComments' own doc comment on AtlassianOps). A pageId
      // this rig wasn't seeded with throws, deliberately, rather than
      // silently returning `[]` or every page's comments — a lookup that
      // can fail loudly on a wrong id is what makes the control below able
      // to fail at all.
      getPageComments: async (pageId: string) => {
        getPageCommentsCalls.push(pageId);
        if (!(pageId in byPage)) throw new Error(`docCommentsRig: no comments seeded for page ${pageId}`);
        return { results: byPage[pageId]! };
      },
      searchProjects: async () => ({ values: [] }),
      getMyself: async () => ({ accountId: "test-account" }),
      getProjectProperty: async (key: string) => {
        const p = properties.get(key);
        if (!p) throw new Error(`no property for ${key}`);
        return p;
      },
      getProjectPropertyOrNull: async (key: string) => properties.get(key) ?? null,
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
    };
    const tools = atlassianTools(ops, () => {});
    return { tools, getPageCommentsCalls };
  }

  const PROJECT_CALLER = { headers: { "x-issue": "BUTCHR" } } as any;
  const ISSUE_CALLER = { headers: { "x-issue": "BUTCHR-1" } } as any;

  // Failure this exists to catch: the guard is missing entirely, or refuses
  // with no explanation an issue caller could act on.
  test("refuses an ISSUE caller, naming why AND pointing at the read it already has (jira_get_issue)", async () => {
    const { tools } = docCommentsRig({ "1": [] });
    await expect(tools.get_doc_comments!.handler({}, ISSUE_CALLER)).rejects.toThrow(/refusing an issue caller/);
    await expect(tools.get_doc_comments!.handler({}, ISSUE_CALLER)).rejects.toThrow(/jira_get_issue/);
  });

  test("refuses a connection with no x-issue", async () => {
    const { tools } = docCommentsRig({ "1": [] });
    const conn = { headers: {} } as any;
    await expect(tools.get_doc_comments!.handler({}, conn)).rejects.toThrow(/refusing/);
  });

  // THE REQUIRED CONTROL (BUTCHR-107's own instruction): fails if the reader
  // ignores the page id and returns cross-page comments — exactly the
  // MEASURED batch-endpoint trap ("12 results for two unrelated pages")
  // named in this ticket's own description. It would also fail if
  // get_doc_comments passed the wrong page id to ops.getPageComments (e.g.
  // a hardcoded/stale one) — docCommentsRig throws on an unseeded id, but
  // page "2" (page B) IS seeded here, so a wrong-id bug would surface as
  // "page B's comment leaked into page A's result", not as a throw.
  test("asserts a DIFFERENT page's comment is NOT returned — fails against a reader that ignores the page id (the batch-endpoint bug this ticket exists to avoid)", async () => {
    const { tools, getPageCommentsCalls } = docCommentsRig(
      {
        "1": [{ id: "10", body: "comment on page A", author: "acc-a" }],
        "2": [{ id: "20", body: "comment on page B — must never appear for project BUTCHR", author: "acc-b" }],
      },
      { rootDocId: "1" },
    );
    const result = (await tools.get_doc_comments!.handler({}, PROJECT_CALLER)) as { results: Array<{ id: string; body: string; author?: string }> };
    expect(getPageCommentsCalls).toEqual(["1"]); // never page "2", never a batched call
    const bodies = result.results.map((c) => c.body);
    expect(bodies).toContain("comment on page A");
    expect(bodies).not.toContain("comment on page B — must never appear for project BUTCHR");
  });

  // Fails if the reshape drops a field — e.g. `author` left `undefined`
  // because the underlying read needs an explicit expansion this op doesn't
  // request (the exact MEASURED trap this codebase already hit once on
  // Jira's `project.lead`; see getPageComments' doc comment on
  // AtlassianOps for what was checked this time).
  test("a project caller gets id, body AND author back, all populated", async () => {
    const { tools } = docCommentsRig({ "1": [{ id: "10", body: "hello from a reviewer", author: "712020:abc" }] });
    const result = (await tools.get_doc_comments!.handler({}, PROJECT_CALLER)) as { results: Array<{ id: string; body: string; author?: string }> };
    expect(result.results).toEqual([{ id: "10", body: "hello from a reviewer", author: "712020:abc" }]);
  });
});

// BUTCHR-184/BUTCHR-188: list_peers, the enumeration half of "two projects
// can talk sideways" — see resolveEligibleProjects (src/resources/project.ts)
// for the SINGLE resolver this verb and staffing discovery both consume.
// Failure conditions stated first, per test, same discipline as check_in's
// own block.
describe("list_peers (BUTCHR-184/BUTCHR-188: enumerate the other eligible projects, excluding the caller)", () => {
  function peersRig(opts: {
    myAccountId?: string;
    projects: Array<{ key: string; name: string; leadAccountId: string }>;
    properties: Record<string, { rootDoc?: { id?: string } } | undefined>; // undefined = genuine 404
    propertyFailures?: Record<string, Error>;
  }) {
    const properties = new Map(
      Object.entries(opts.properties).filter(([, v]) => v !== undefined) as [string, { rootDoc?: { id?: string } }][],
    );
    const ops: AtlassianOps = {
      getIssue: async () => ({ ok: true }),
      getIssueComments: async () => ({ results: [] }),
      search: async () => ({ issues: [] }),
      addComment: async () => ({ ok: true }),
      linkIssues: async () => ({ ok: true }),
      transition: async () => ({ ok: true }),
      createIssue: async () => ({ ok: true }),
      setPriority: async () => ({ ok: true }),
      assign: async () => ({ ok: true }),
      createPage: async () => ({ ok: true }),
      getPage: async () => ({ ok: true }),
      updatePage: async () => ({ ok: true }),
      searchPages: async () => ({ results: [] }),
      listSpaces: async () => ({ ok: true }),
      getRemoteLink: async () => null,
      upsertRemoteLink: async () => ({ ok: true }),
      getChildPages: async () => ({ results: [] }),
      getPageLabels: async () => [],
      createPageWithLabel: async () => ({ id: "x", title: "x", url: "x" }),
      addLabels: async () => ({ ok: true }),
      removeLabels: async () => ({ ok: true }),
      deleteIssue: async () => ({ ok: true }),
      correctText: async () => ({ ok: true }),
      commentOnPage: async () => ({ ok: true }),
      getPageComments: async () => ({ results: [] }),
      searchProjects: async () => ({ values: opts.projects.map((p) => ({ key: p.key, name: p.name, lead: { accountId: p.leadAccountId } })) }),
      getMyself: async () => ({ accountId: opts.myAccountId ?? "acct-me" }),
      getProjectProperty: async (key: string) => {
        const p = properties.get(key);
        if (!p) throw new Error(`no property for ${key}`);
        return p;
      },
      getProjectPropertyOrNull: async (key: string) => {
        if (opts.propertyFailures?.[key]) throw opts.propertyFailures[key];
        return properties.get(key) ?? null;
      },
      setProjectProperty: async () => ({ ok: true }),
      getPageVersions: async () => ({}),
    };
    const tools = atlassianTools(ops, () => {});
    return { tools };
  }

  // REQUIRED (1/4): the guard is missing entirely, or refuses with no
  // explanation an issue caller could act on.
  test("refuses an ISSUE caller, naming why", async () => {
    const { tools } = peersRig({ projects: [], properties: {} });
    const conn = { headers: { "x-issue": "BUTCHR-1" } } as any;
    await expect(tools.list_peers!.handler({}, conn)).rejects.toThrow(/refusing an issue caller/);
  });

  test("refuses a connection with no x-issue", async () => {
    const { tools } = peersRig({ projects: [], properties: {} });
    const conn = { headers: {} } as any;
    await expect(tools.list_peers!.handler({}, conn)).rejects.toThrow(/refusing/);
  });

  // REQUIRED (2/4): the caller's own project appearing in its own peer
  // list — the resolver has no notion of "self", so the exclusion must be
  // applied by list_peers itself; removing that filter is what this test
  // must catch.
  test("excludes the caller from its own list, even though it is equally eligible", async () => {
    const { tools } = peersRig({
      myAccountId: "acct-A",
      projects: [
        { key: "BUTCHR", name: "Butchr", leadAccountId: "acct-A" },
        { key: "DROVR", name: "Drovr", leadAccountId: "acct-A" },
      ],
      properties: {
        BUTCHR: { rootDoc: { id: "doc-butchr" } },
        DROVR: { rootDoc: { id: "doc-drovr" } },
      },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = (await tools.list_peers!.handler({}, conn)) as { results: Array<{ key: string; name: string }> };
    expect(result.results).toEqual([{ key: "DROVR", name: "Drovr" }]);
  });

  // REQUIRED (3/4): a project with no readable butchr property (a genuine
  // 404) still showing up as a peer.
  test("a project that is live but has no readable butchr property is NOT a peer", async () => {
    const { tools } = peersRig({
      myAccountId: "acct-A",
      projects: [
        { key: "BUTCHR", name: "Butchr", leadAccountId: "acct-A" },
        { key: "NOPROP", name: "No Property", leadAccountId: "acct-A" },
      ],
      properties: {
        BUTCHR: { rootDoc: { id: "doc-butchr" } },
        NOPROP: undefined,
      },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = (await tools.list_peers!.handler({}, conn)) as { results: Array<{ key: string; name: string }> };
    expect(result.results).toEqual([]);
  });

  // REQUIRED (4/4): leadership is not actually enforced, so a project led by
  // a totally different account leaks into the peer list.
  test("a project led by a DIFFERENT account is NOT a peer", async () => {
    const { tools } = peersRig({
      myAccountId: "acct-A",
      projects: [
        { key: "BUTCHR", name: "Butchr", leadAccountId: "acct-A" },
        { key: "OTHER", name: "Someone Else's", leadAccountId: "acct-B" },
      ],
      properties: {
        BUTCHR: { rootDoc: { id: "doc-butchr" } },
        OTHER: { rootDoc: { id: "doc-other" } },
      },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = (await tools.list_peers!.handler({}, conn)) as { results: Array<{ key: string; name: string }> };
    expect(result.results).toEqual([]);
  });

  // Not one of the four required behaviors, but the ticket's central
  // distinction: eligibility, not the staffing allowlist. list_peers has no
  // allowlist to consult at all (atlassianTools receives no such
  // dependency) — this proves an eligible project appears as a peer with
  // nothing beyond leadership + a readable property, which is the whole
  // point (an unstaffed-but-eligible project is still a valid peer).
  test("results carry only key/name — no rootDocId or page url leaks into the verb's return", async () => {
    const { tools } = peersRig({
      myAccountId: "acct-A",
      projects: [
        { key: "BUTCHR", name: "Butchr", leadAccountId: "acct-A" },
        { key: "DROVR", name: "Drovr", leadAccountId: "acct-A" },
      ],
      properties: {
        BUTCHR: { rootDoc: { id: "doc-butchr" } },
        DROVR: { rootDoc: { id: "doc-drovr" } },
      },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    const result = (await tools.list_peers!.handler({}, conn)) as { results: Array<Record<string, unknown>> };
    expect(result.results).toEqual([{ key: "DROVR", name: "Drovr" }]);
    expect(Object.keys(result.results[0]!).sort()).toEqual(["key", "name"]);
  });

  // Worth a test though not one of the required four (BUTCHR-188): a
  // non-404 read failure must propagate rather than being swallowed into a
  // shorter-than-true peer list.
  test("a NON-404 property read failure propagates rather than silently excluding that project", async () => {
    const { tools } = peersRig({
      myAccountId: "acct-A",
      projects: [{ key: "FLAKY", name: "Flaky", leadAccountId: "acct-A" }],
      properties: { FLAKY: { rootDoc: { id: "doc-flaky" } } },
      propertyFailures: { FLAKY: new Error("503 Service Unavailable (simulated transient failure)") },
    });
    const conn = { headers: { "x-issue": "BUTCHR" } } as any;
    await expect(tools.list_peers!.handler({}, conn)).rejects.toThrow(/503/);
  });
});
