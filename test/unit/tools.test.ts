import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

/** Defaults for the get_doc/set_doc ops (BUTCHR-33) and the label/delete ops (BUTCHR-35) shared by every rig() below; override per test as needed. */
function fakeDocOps(overrides: Partial<Pick<AtlassianOps, "getProjectProperty" | "getRemoteLink" | "upsertRemoteLink" | "getChildPages" | "getPageLabels" | "createPageWithLabel" | "addLabels" | "removeLabels" | "deleteIssue">> = {}) {
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
    ...fakeDocOps(),
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
      "confluence_create_page", "confluence_get_page", "confluence_list_spaces", "confluence_search_pages", "confluence_update_page",
      "file_where_it_belongs", "finish_without_a_boss", "finish_worker",
      "get_doc",
      "jira_add_comment", "jira_assign", "jira_create_issue", "jira_get_issue", "jira_link_issues", "jira_search",
      "jira_set_priority", "jira_transition",
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
    };
    const writes: Array<[string[], string]> = [];
    const tools = atlassianTools(ops, () => {}, { task: "acct-task" }, (keys: readonly string[], writer: string) => writes.push([[...keys], writer]));
    const conn = { headers: { "x-issue": "KAN-1" } } as any;
    const result = (await tools.adopt_worker!.handler({ key: "KAN-9", disposition: "start" }, conn)) as { key: string; alreadyAdopted: boolean };
    expect(result.key).toBe("KAN-9");
    expect(result.alreadyAdopted).toBe(false);
    expect(writes).toEqual([[["KAN-9", "KAN-1"], "KAN-1"]]);
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
