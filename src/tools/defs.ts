import { z } from "@brooswit/thatch";
import type { ToolDef } from "@brooswit/thatch";
import type { AtlassianOps } from "./atlassian.js";

/**
 * The daemon's MCP tools: a thin proxy over the de-facto Atlassian SDKs,
 * executed daemon-side with the shared credential. No scoping — any agent may
 * call any tool; `log` records which connection (x-issue) did what.
 */
export function atlassianTools(ops: AtlassianOps, log: (line: string) => void = console.error): Record<string, ToolDef<any>> {
  const audit = (c: { headers: Record<string, string> }, what: string) =>
    log(`  [tools] ${c.headers["x-issue"] ?? "?"} → ${what}`);
  return {
    jira_get_issue: {
      description: "Read a Jira issue (fields incl. description, status, parent, labels).",
      input: { key: z.string() },
      handler: (a, c) => { const { key } = a as { key: string }; audit(c, `get ${key}`); return ops.getIssue(key); },
    },
    jira_search: {
      description: "Search Jira issues by JQL. Returns matching issues.",
      input: { jql: z.string(), maxResults: z.number().int().min(1).max(100).default(25) },
      handler: (a, c) => { const { jql, maxResults } = a as { jql: string; maxResults: number }; audit(c, `search ${jql.slice(0, 60)}`); return ops.search(jql, maxResults ?? 25); },
    },
    jira_link_issues: {
      description: "Link two issues. The IMPLEMENTER is `from` — the outward side: task implements story ⇒ from=task, to=story; story implements epic ⇒ from=story, to=epic. This link is what routes a ticket's events (In Review, comments) to its boss — nothing else is listened to (the Jira parent field is membership only). Defaults to type \"Implements\"; pass an explicit `type` for other link kinds (Blocks, Relates, …).",
      input: { from: z.string(), to: z.string(), type: z.string().default("Implements") },
      handler: (a, c) => {
        const { from, to, type } = a as { from: string; to: string; type?: string };
        const resolvedType = type ?? "Implements";
        audit(c, `link ${from} → ${to} (${resolvedType})`);
        // Jira's POST /issueLink answers 201 with an EMPTY body, so the op
        // resolves undefined even though the link was created — an MCP result
        // with content[0].text === undefined is invalid and the client rejects
        // the whole call (KAN-764). Substitute a real value in that case.
        return ops.linkIssues(from, to, resolvedType).then((r) => r ?? { ok: true, from, to, type: resolvedType });
      },
    },
    jira_add_comment: {
      description: "Add a plain-text comment to a Jira issue.",
      input: { key: z.string(), text: z.string() },
      handler: (a, c) => {
        const { key, text } = a as { key: string; text: string };
        audit(c, `comment ${key}`);
        // Attribution is enforced HERE, not by agent etiquette: every comment an
        // agent posts is prefixed with its identity tag, so on a shared Jira
        // account a bare untagged comment is, by convention, the human.
        const who = c.headers["x-issue"];
        const tag = who ? `[${who}] ` : "";
        const body = tag && !text.startsWith(`[${who}]`) ? tag + text : text;
        return ops.addComment(key, body);
      },
    },
    jira_transition: {
      description: 'Move a Jira issue to a status by name, e.g. "In Progress", "In Review", "Done".',
      input: { key: z.string(), status: z.string() },
      handler: (a, c) => { const { key, status } = a as { key: string; status: string }; audit(c, `transition ${key} → ${status}`); return ops.transition(key, status); },
    },
    jira_create_issue: {
      description: "Create a Jira issue. Set parent to nest a Story under an Epic or a Task under a Story. Set assignee to an Atlassian accountId — an unassigned ticket is never staffed, so a ticket you intend to be worked MUST have one. The ticket you write is the interface: put the full context and a concrete definition of done in the description.",
      input: {
        projectKey: z.string(), issuetype: z.enum(["Epic", "Story", "Task"]), summary: z.string(),
        description: z.string().optional(), parent: z.string().optional(), labels: z.array(z.string()).optional(),
        assignee: z.string().optional(),
      },
      handler: (a, c) => { const p = a as { projectKey: string; issuetype: "Epic" | "Story" | "Task"; summary: string; description?: string; parent?: string; labels?: string[]; assignee?: string }; audit(c, `create ${p.issuetype} under ${p.parent ?? "(none)"}`); return ops.createIssue(p); },
    },
    confluence_create_page: {
      description: "Create a Confluence page (storage/XHTML body) in a space.",
      input: { spaceId: z.string(), title: z.string(), body: z.string() },
      handler: (a, c) => { const p = a as { spaceId: string; title: string; body: string }; audit(c, `page "${p.title}"`); return ops.createPage(p); },
    },
    confluence_get_page: {
      description: "Read a Confluence page by id (storage body).",
      input: { id: z.string() },
      handler: (a, c) => { const { id } = a as { id: string }; audit(c, `read page ${id}`); return ops.getPage(id); },
    },
    confluence_list_spaces: {
      description: "List Confluence spaces (to find a spaceId).",
      input: {},
      handler: (_a, c) => { audit(c, "list spaces"); return ops.listSpaces(); },
    },
  };
}
