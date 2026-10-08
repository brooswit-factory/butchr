/**
 * FACTORY-732 (implementing FACTORY-721): `restrictJiraProjectManagers`
 * (src/tools/jira-project-scope.ts) — the project-scoped Jira allowlist for
 * `jira-project` ("manager") callers. Covers: allowed tools in their own
 * project, cross-project refusal, the moved-issue case (GET-first beats key
 * prefix), JQL wrapping, every other tool refused, and that every call
 * (allowed or refused) is logged.
 */
import { describe, expect, test } from "bun:test";
import type { ToolDef } from "@brooswit/thatch";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { Refusal } from "../../src/tools/outcome.js";
import { JIRA_PROJECT_MANAGER_TOOLS, restrictJiraProjectManagers } from "../../src/tools/jira-project-scope.js";

const managerKey = (project: string) => encodeAgentKey({ resourceProvider: "jira-project", ruleId: "manager", resourceId: project });
const managerConn = (project: string) => ({ headers: { "x-butchr-agent": managerKey(project) } }) as any;
const workConn = (issue: string) => ({ headers: { "x-issue": issue } }) as any;

function fakeIssue(projectKey: string) {
  return { fields: { project: { key: projectKey } } };
}

function rig() {
  const getIssueCalls: string[] = [];
  const issuesByKey = new Map<string, string>(); // key -> real project key
  const ops = {
    getIssue: async (key: string) => {
      getIssueCalls.push(key);
      const project = issuesByKey.get(key);
      if (!project) throw new Error(`no such issue: ${key}`);
      return fakeIssue(project);
    },
  };
  const handlerCalls: Array<[string, unknown]> = [];
  const mkTool = (name: string): ToolDef<any> => ({
    description: "d",
    input: {},
    handler: (a: unknown) => { handlerCalls.push([name, a]); return { ok: name }; },
  });
  const toolNames = [...JIRA_PROJECT_MANAGER_TOOLS, "jira_create_issue", "jira_assign", "jira_set_priority", "jira_link_issues", "add_link", "remove_link", "freeze_session", "confluence_create_page", "confluence_update_page", "set_doc", "new_worker"];
  const tools: Record<string, ToolDef<any>> = {};
  for (const name of toolNames) tools[name] = mkTool(name);
  const logs: string[] = [];
  const gated = restrictJiraProjectManagers(tools, ops, (l) => logs.push(l));
  return { gated, ops, issuesByKey, getIssueCalls, handlerCalls, logs };
}

async function call(tools: Record<string, ToolDef<any>>, name: string, args: unknown, conn: unknown) {
  return tools[name]!.handler(args as never, conn as never);
}

describe("restrictJiraProjectManagers", () => {
  test("allowed tools reach the real handler when the issue belongs to the caller's own project", async () => {
    const { gated, issuesByKey, handlerCalls } = rig();
    issuesByKey.set("BUTCHR-1", "BUTCHR");
    expect(await call(gated, "jira_get_issue", { key: "BUTCHR-1" }, managerConn("BUTCHR"))).toEqual({ ok: "jira_get_issue" });
    expect(await call(gated, "jira_add_comment", { key: "BUTCHR-1", text: "hi" }, managerConn("BUTCHR"))).toEqual({ ok: "jira_add_comment" });
    expect(await call(gated, "jira_transition", { key: "BUTCHR-1", status: "Done" }, managerConn("BUTCHR"))).toEqual({ ok: "jira_transition" });
    expect(handlerCalls.map((c) => c[0])).toEqual(["jira_get_issue", "jira_add_comment", "jira_transition"]);
  });

  test("transition to Done is allowed like any other status — no status is special-cased", async () => {
    const { gated, issuesByKey } = rig();
    issuesByKey.set("BUTCHR-1", "BUTCHR");
    await expect(call(gated, "jira_transition", { key: "BUTCHR-1", status: "Done" }, managerConn("BUTCHR"))).resolves.toEqual({ ok: "jira_transition" });
  });

  test("a non-jira-project caller (plain jira-work, or no identity) passes through completely untouched", async () => {
    const { gated, handlerCalls, logs } = rig();
    await call(gated, "jira_create_issue", { summary: "x" }, workConn("BUTCHR-1"));
    await call(gated, "jira_get_issue", { key: "ANY-9" }, { headers: {} });
    expect(handlerCalls.map((c) => c[0])).toEqual(["jira_create_issue", "jira_get_issue"]);
    expect(logs).toEqual([]); // untouched means no gate decision was made, so no gate log line either
  });

  describe("cross-project refusal", () => {
    test("jira_get_issue/add_comment/transition on an issue belonging to a DIFFERENT project is refused", async () => {
      const { gated, issuesByKey, handlerCalls, logs } = rig();
      issuesByKey.set("OTHER-1", "OTHER");
      await expect(call(gated, "jira_get_issue", { key: "OTHER-1" }, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      await expect(call(gated, "jira_add_comment", { key: "OTHER-1", text: "x" }, managerConn("BUTCHR"))).rejects.toThrow("belongs to project OTHER, not its own project BUTCHR");
      await expect(call(gated, "jira_transition", { key: "OTHER-1", status: "Done" }, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      expect(handlerCalls).toEqual([]);
      expect(logs.some((l) => l.includes("refused jira_get_issue OTHER-1") && l.includes("not its own project BUTCHR"))).toBe(true);
    });
  });

  describe("the moved-issue case", () => {
    test("GET-first resolves the issue's CURRENT project, so a key whose PREFIX still names the caller's own project is still refused once the issue has moved elsewhere", async () => {
      const { gated, issuesByKey, handlerCalls, getIssueCalls } = rig();
      // "BUTCHR-9" LOOKS like it belongs to BUTCHR from its key prefix alone, but it was moved to FACTORY.
      issuesByKey.set("BUTCHR-9", "FACTORY");
      await expect(call(gated, "jira_get_issue", { key: "BUTCHR-9" }, managerConn("BUTCHR"))).rejects.toThrow("belongs to project FACTORY, not its own project BUTCHR");
      expect(getIssueCalls).toEqual(["BUTCHR-9"]); // the gate itself did the GET — never trusted the key's own prefix
      expect(handlerCalls).toEqual([]);
    });

    test("conversely, a key whose prefix names a DIFFERENT project is ALLOWED once GET-first shows it moved INTO the caller's own project", async () => {
      const { gated, issuesByKey, handlerCalls } = rig();
      issuesByKey.set("FACTORY-9", "BUTCHR");
      expect(await call(gated, "jira_get_issue", { key: "FACTORY-9" }, managerConn("BUTCHR"))).toEqual({ ok: "jira_get_issue" });
      expect(handlerCalls).toEqual([["jira_get_issue", { key: "FACTORY-9" }]]);
    });
  });

  describe("malformed/missing keys", () => {
    test("a key failing the strict Jira key regex is refused before any GET", async () => {
      const { gated, getIssueCalls } = rig();
      await expect(call(gated, "jira_get_issue", { key: "not a key" }, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      await expect(call(gated, "jira_add_comment", { key: "lowercase-1", text: "x" }, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      expect(getIssueCalls).toEqual([]);
    });
  });

  describe("JQL wrapping", () => {
    test("jira_search's JQL is WRAPPED with the caller's own project, never parsed/detected", async () => {
      const { gated, handlerCalls } = rig();
      await call(gated, "jira_search", { jql: "status = Open", maxResults: 10 }, managerConn("BUTCHR"));
      expect(handlerCalls).toEqual([["jira_search", { jql: "project = BUTCHR AND (status = Open)", maxResults: 10 }]]);
    });

    test("a caller cannot smuggle a different project in via its own OR clause — the wrapper always AND-s its own clause around the whole thing", async () => {
      const { gated, handlerCalls } = rig();
      await call(gated, "jira_search", { jql: "project = OTHER OR status = Open" }, managerConn("BUTCHR"));
      expect(handlerCalls).toEqual([["jira_search", { jql: "project = BUTCHR AND (project = OTHER OR status = Open)" }]]);
    });
  });

  describe("every other tool is refused", () => {
    test.each([
      "jira_create_issue", "jira_assign", "jira_set_priority", "jira_link_issues",
      "add_link", "remove_link", "freeze_session",
      "confluence_create_page", "confluence_update_page", "set_doc", "new_worker",
    ])("%s is refused for a jira-project (manager) caller", async (name) => {
      const { gated, handlerCalls } = rig();
      await expect(call(gated, name, {}, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      expect(handlerCalls).toEqual([]);
    });
  });

  describe("a query-level (singleton/persistent) jira-project caller", () => {
    test("has no single project to scope to, so it is refused on every tool, never passed through unscoped", async () => {
      const { gated, handlerCalls } = rig();
      const queryConn = { headers: { "x-butchr-agent": "jira-project:manager:%40query" } } as any;
      await expect(call(gated, "jira_get_issue", { key: "BUTCHR-1" }, queryConn)).rejects.toThrow("no single project to scope this call to");
      expect(handlerCalls).toEqual([]);
    });
  });

  describe("logging", () => {
    test("every refusal is logged, naming the caller and the tool", async () => {
      const { gated, logs } = rig();
      await expect(call(gated, "jira_create_issue", {}, managerConn("BUTCHR"))).rejects.toBeInstanceOf(Refusal);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(managerKey("BUTCHR"));
      expect(logs[0]).toContain("refused jira_create_issue");
    });

    test("the JQL-wrap decision is logged even though the call is allowed", async () => {
      const { gated, logs } = rig();
      await call(gated, "jira_search", { jql: "status = Open" }, managerConn("BUTCHR"));
      expect(logs.some((l) => l.includes("jira-project scope") && l.includes("wrapped jira_search JQL"))).toBe(true);
    });
  });
});
