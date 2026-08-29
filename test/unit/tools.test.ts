import { describe, expect, test } from "bun:test";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

function rig(roles: { story?: string; task?: string } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, result: unknown = { ok: name }) => (...a: unknown[]) => { calls.push([name, a]); return Promise.resolve(result); };
  const ops: AtlassianOps = {
    getIssue: rec("getIssue"), search: rec("search"), addComment: rec("addComment"), linkIssues: rec("linkIssues"),
    transition: rec("transition"), createIssue: rec("createIssue", { key: "KAN-999" }), setPriority: rec("setPriority"),
    assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), listSpaces: rec("listSpaces"),
  };
  const audits: string[] = [];
  const tools = atlassianTools(ops, (l) => audits.push(l), roles);
  const conn = { headers: { "x-issue": "KAN-7" } } as any;
  return { tools, calls, audits, conn };
}

describe("atlassianTools", () => {
  test("exposes the full proxy surface", () => {
    const { tools } = rig();
    expect(Object.keys(tools).sort()).toEqual([
      "confluence_create_page", "confluence_get_page", "confluence_list_spaces",
      "jira_add_comment", "jira_assign", "jira_create_issue", "jira_get_issue", "jira_link_issues", "jira_search",
      "jira_set_priority", "jira_transition",
    ]);
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
    await tools.confluence_list_spaces!.handler({}, conn);
    expect(calls.map(([n]) => n)).toEqual(["getIssue", "search", "addComment", "transition", "createIssue", "linkIssues", "linkIssues", "setPriority", "createPage", "getPage", "listSpaces"]);
    expect(calls[1]![1]).toEqual(["project = KAN", 5]);
    expect((calls[4]![1][0] as { assignee?: string }).assignee).toBe("acct-1");   // assignee reaches the op
    expect(calls[5]![1]).toEqual(["KAN-999", "KAN-2", "Implements"]);             // create's own auto-link, to the parent
    expect(calls[6]![0]).toBe("linkIssues");
    expect(calls[6]![1]).toEqual(["KAN-2", "KAN-9", "Implements"]);               // the explicit jira_link_issues call; default type applied
    expect(audits.every((a) => a.includes("KAN-7"))).toBe(true);
    expect(audits.length).toBe(10);
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

describe("jira_link_issues invalid MCP result (KAN-764)", () => {
  test("substitutes a real value when the op resolves undefined (Jira's empty 201 body)", async () => {
    const { conn } = rig();
    const ops: AtlassianOps = {
      getIssue: async () => ({}), search: async () => ({}), addComment: async () => ({}),
      linkIssues: async () => undefined, transition: async () => ({}), createIssue: async () => ({}),
      setPriority: async () => ({}), assign: async () => ({}),
      createPage: async () => ({}), getPage: async () => ({}), listSpaces: async () => ({}),
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
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), listSpaces: rec("listSpaces"),
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
      createPage: async () => ({}), getPage: async () => ({}), listSpaces: async () => ({}),
    };
    const tools = atlassianTools(ops, () => {});
    const result = await tools.jira_set_priority!.handler({ key: "KAN-1", priority: "High" }, { headers: {} } as any);
    expect(result).toEqual({ ok: true, key: "KAN-1", priority: "High" });
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
      assign: rec("assign"), createPage: rec("createPage"), getPage: rec("getPage"), listSpaces: rec("listSpaces"),
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
