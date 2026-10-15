import { z, type ToolDef } from "@brooswit/thatch";
import type { AtlassianOps } from "./atlassian.js";
import { atlassianTools } from "./defs.js";
import { isIssueKey, isProjectId } from "../resources/id.js";
import { withOutcomeRecording } from "./outcome.js";

/** Provider operations, without staffing, ownership or completion policy. */
export function providerAtlassianTools(
  ops: AtlassianOps, log: (line: string) => void = console.error,
  onWrite?: (keys: readonly string[], writer: string) => void,
): Record<string, ToolDef<any>> {
  const key = z.string().refine(isIssueKey, "Expected a Jira issue key");
  const project = z.string().refine(isProjectId, "Expected a Jira project key");
  const text = z.string().min(1);
  const existing = atlassianTools(ops, log, {}, onWrite);
  const tools: Record<string, ToolDef<any>> = {};
  // These provider handlers already preserve paging, optimistic locking and receipts.
  for (const name of ["confluence_create_page", "confluence_update_page", "confluence_search_pages", "confluence_get_page", "confluence_list_spaces"]) {
    tools[name] = existing[name]!;
  }
  tools.confluence_create_page!.description = "Create a Confluence page in an explicit space, optionally under an explicit parent. Body is storage XHTML.";
  tools.confluence_update_page!.description = "Replace the specified Confluence page body (storage XHTML), optionally its title. The provider adapter uses optimistic version locking.";
  tools.confluence_get_page!.description = "Read the specified Confluence page, including its storage body.";
  function noted(c: { headers: Record<string, string> }, keys: string[]) {
    const writer = c.headers["x-butchr-agent"] ?? c.headers["x-issue"];
    if (writer) {
      try { onWrite?.(keys, writer); }
      catch (error) { log(`WARNING: provider write landed, own-write recording failed: ${(error as Error).message}`); }
    }
  }
  function write(name: string, description: string, input: Record<string, any>, keys: (a: any) => string[], run: (a: any, c: any) => Promise<unknown>) {
    tools[name] = { description, input, handler: async (a, c) => {
      const result = await run(a, c);
      noted(c, keys(a));
      return result ?? { ok: true };
    } };
  }
  tools.jira_get_issue = { description: "Read the specified Jira issue using the connected account.", input: { key }, handler: (a) => ops.getIssue((a as { key: string }).key) };
  tools.jira_search = { description: "Search Jira using JQL and the connected account's permissions.", input: { jql: text, maxResults: z.number().int().min(1).max(100).default(25) }, handler: (a) => { const p = a as { jql: string; maxResults: number }; return ops.search(p.jql, p.maxResults); } };
  write("jira_add_comment", "Comment on the specified Jira issue, attributed to the caller.", { key, text }, a => [a.key], (a, c) => {
    const actor = c.headers["x-butchr-agent"] ?? c.headers["x-issue"] ?? "butchr";
    const tag = `[${actor}]`;
    return ops.addComment(a.key, a.text.startsWith(tag) ? a.text : `${tag} ${a.text}`);
  });
  write("jira_transition", "Transition the specified issue to a status supported by Jira. Review and dependency conventions belong to the workflow.", { key, status: text }, a => [a.key], a => ops.transition(a.key, a.status));
  write("jira_set_priority", "Set the specified Jira issue's priority by name.", { key, priority: text }, a => [a.key], a => ops.setPriority(a.key, a.priority));
  write("jira_assign", "Assign the specified Jira issue to an explicit Atlassian account ID. No role expansion.", { key, assignee: text }, a => [a.key], a => ops.assign(a.key, a.assignee));
  write("jira_update_issue", "Replace only the supplied summary and/or description on the specified Jira issue.", { key, summary: text.optional(), description: z.string().optional() }, a => [a.key], async a => {
    if (a.summary === undefined && a.description === undefined) throw new Error("Supply summary or description");
    return ops.correctText(a.key, { ...(a.summary !== undefined ? { summary: a.summary } : {}), ...(a.description !== undefined ? { description: a.description } : {}) });
  });
  write("jira_link_issues", "Create an explicit Jira issue relationship. This does not grant tool permissions.", { from: key, to: key, type: text }, a => [a.from, a.to], a => ops.linkIssues(a.from, a.to, a.type));
  tools.jira_create_issue = {
    description: "Create a Jira issue with explicit fields. Jira supplies omitted defaults; Butchr does not infer assignee, parent or hierarchy. Optional implements is a compatibility convenience for an explicit link, reported separately from creation.",
    input: { projectKey: project, issuetype: text, summary: text, description: z.string().optional(), parent: key.optional(), labels: z.array(text).optional(), assignee: text.optional(), priority: text.optional(), implements: key.optional() },
    handler: async (a, c) => {
      const { implements: target, ...fields } = a as Parameters<AtlassianOps["createIssue"]>[0] & { implements?: string };
      const result = await ops.createIssue(fields) as { key?: string };
      if (result?.key) noted(c, [result.key]);
      if (!result?.key) return { ...result, creation: "unconfirmed", warning: "Create returned no issue key. Inspect Jira before retrying; no link was attempted." };
      if (!target) return result;
      try {
        await ops.linkIssues(result.key, target, "Implements");
        noted(c, [result.key, target]);
        return { ...result, implements: { ok: true, to: target } };
      } catch (e) {
        return { ...result, implements: { ok: false, to: target, error: (e as Error).message } };
      }
    },
  };
  // Validate even direct in-process calls, before any provider side effects.
  for (const [name, def] of Object.entries(tools)) {
    const handler = def.handler;
    tools[name] = { ...def, handler: (a, c) => handler(z.object(def.input).strict().parse(a), c) };
  }
  return withOutcomeRecording(tools, log);
}
