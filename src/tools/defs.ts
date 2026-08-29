import { z } from "@brooswit/thatch";
import type { ToolDef } from "@brooswit/thatch";
import type { AtlassianOps } from "./atlassian.js";

/** Role -> Atlassian accountId, for staffing `jira_create_issue` by issuetype (see src/config/config.ts `assignees`). */
export interface AssigneeRoles {
  story?: string;
  task?: string;
}

/**
 * Jira's write endpoints (POST /issueLink, PUT .../editIssue) answer a
 * successful 2xx with an EMPTY body — the op then resolves `undefined` even
 * though the write succeeded. An MCP result with content[0].text === undefined
 * is invalid and the client rejects the whole call (KAN-764, and the same
 * shape in jira_set_priority as KAN-803). Every write tool routes its
 * resolved value through this so `undefined` is never mistaken for a
 * failure, and the substitution can never drift between call sites.
 */
function orOk<T>(r: unknown, fallback: T): T {
  return (r ?? fallback) as T;
}

/** AccountIds are not secrets; truncate them only for readability, never redact. */
const truncAccountId = (id: string): string => (id.length > 11 ? `${id.slice(0, 11)}…` : id);

const noAssigneeMsg = (issuetype: "Story" | "Task"): string => {
  const envVar = issuetype === "Story" ? "BUTCHR_ASSIGNEE_STORY" : "BUTCHR_ASSIGNEE_TASK";
  return `jira_create_issue: no assignee for a ${issuetype} — set ${envVar} (an Atlassian accountId) on this daemon, or pass an explicit assignee`;
};

// A Story can genuinely parent to an Epic, so both `implements` and `parent`
// are open routes there. A Task CANNOT parent to a Story in this project
// (Jira 400s — Story and Task are both hierarchy level 0), so for a Task
// `implements` isn't one of two options, it's the only one — the refusal
// says so plainly instead of offering a route that doesn't exist.
const noTargetMsg = (issuetype: "Story" | "Task"): string =>
  issuetype === "Task"
    ? 'jira_create_issue: a Task cannot have a Story parent in this project — pass `implements=<story key>`, or `implements: "none"` to file a deliberate orphan'
    : 'jira_create_issue: a Story implements an Epic and a Task implements a Story — pass `implements` (the key it reports to), or `parent`, or `implements: "none"` to file a deliberate orphan';

/**
 * The daemon's MCP tools: a thin proxy over the de-facto Atlassian SDKs,
 * executed daemon-side with the shared credential. No scoping — any agent may
 * call any tool; `log` records which connection (x-issue) did what. `roles`
 * is the Story/Task assignee mapping `jira_create_issue` staffs by; injected
 * rather than read from config here so this module stays pure over its ops
 * and unit-testable without a config fixture.
 */
export function atlassianTools(ops: AtlassianOps, log: (line: string) => void = console.error, roles: AssigneeRoles = {}): Record<string, ToolDef<any>> {
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
        return ops.linkIssues(from, to, resolvedType).then((r) => orOk(r, { ok: true, from, to, type: resolvedType }));
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
      description:
        "Create a Jira issue. ASSIGNMENT: a Story or a Task is assigned BY ROLE from its issuetype (configured on this daemon) — pass an explicit `assignee` (an Atlassian accountId) to override, which always wins; an Epic is unchanged (caller-supplied assignee, or none — Epics are the human's). If the role's accountId isn't configured on this daemon and you passed no `assignee`, the call is REFUSED. HOME: a Story or a Task also requires a home — pass `implements` (the issue key it reports to: a Story implements an Epic, a Task implements a Story) or `parent` (nests it in Jira for membership; a Story can parent to an Epic, but a Task CANNOT parent to a Story in this project — use `implements` for Tasks). Omitting both refuses the call; an Epic needs neither. OPT-OUT: pass `implements: \"none\"` (case-insensitive) to file a deliberate orphan — the ticket is still created and still staffed by role, but no link is made; use this ONLY for the explicit out-of-scope/triage tickets your brief tells you to file outside your epic — silence (omitting both `implements` and `parent`) is never the opt-out. LINKING: after creating the issue, the tool itself creates the Implements link (from = the new issue, to = the resolved target) — the result carries both the new `key` and the link outcome as `implements: { ok, to, error? }`; a link failure never hides the key, so retry the LINK, not the create, on failure. Set priority (a Jira priority name) to set a boss's child's priority at filing — omit it to take the site default. The ticket you write is the interface: put the full context and a concrete definition of done in the description.",
      input: {
        projectKey: z.string(), issuetype: z.enum(["Epic", "Story", "Task"]), summary: z.string(),
        description: z.string().optional(), parent: z.string().optional(), labels: z.array(z.string()).optional(),
        assignee: z.string().optional(), priority: z.string().optional(), implements: z.string().optional(),
      },
      handler: async (a, c) => {
        const p = a as {
          projectKey: string; issuetype: "Epic" | "Story" | "Task"; summary: string; description?: string;
          parent?: string; labels?: string[]; assignee?: string; priority?: string; implements?: string;
        };

        // (1) Assign by role, regardless of parent — an explicit `assignee` always wins.
        // A refusal is still something a connection did, so it gets its own audit line
        // before the throw — otherwise the operator watching the daemon log sees nothing.
        let assignee = p.assignee;
        if (!assignee && p.issuetype !== "Epic") {
          assignee = p.issuetype === "Story" ? roles.story : roles.task;
          if (!assignee) {
            const envVar = p.issuetype === "Story" ? "BUTCHR_ASSIGNEE_STORY" : "BUTCHR_ASSIGNEE_TASK";
            audit(c, `create ${p.issuetype} under ${p.parent ?? "(none)"} REFUSED: no assignee (${envVar} unset)`);
            throw new Error(noAssigneeMsg(p.issuetype));
          }
        }

        // (2)/(3) Resolve the Implements target: implements > parent > refuse; "none" opts out (still assigned, no link).
        let target: string | undefined;
        let orphan = false;
        if (p.issuetype !== "Epic") {
          const impl = p.implements?.trim();
          if (impl && impl.toLowerCase() === "none") {
            orphan = true;
          } else if (impl) {
            target = impl;
          } else if (p.parent) {
            target = p.parent;
          } else {
            audit(c, `create ${p.issuetype} under (none) REFUSED: no implements target`);
            throw new Error(noTargetMsg(p.issuetype));
          }
        }

        // (4) Audit line: type/parent, resolved target ("orphan by request" for the opt-out), resolved assignee.
        let line = `create ${p.issuetype} under ${p.parent ?? "(none)"}`;
        if (p.issuetype !== "Epic") line += orphan ? " orphan by request" : ` implements ${target}`;
        if (assignee) line += ` → ${truncAccountId(assignee)}`;
        audit(c, line);

        const created = (await ops.createIssue({
          projectKey: p.projectKey, issuetype: p.issuetype, summary: p.summary,
          ...(p.description ? { description: p.description } : {}),
          ...(p.parent ? { parent: p.parent } : {}),
          ...(p.labels?.length ? { labels: p.labels } : {}),
          ...(assignee ? { assignee } : {}),
          ...(p.priority ? { priority: p.priority } : {}),
        })) as { key?: string } & Record<string, unknown>;
        const key = created.key;

        if (p.issuetype === "Epic" || orphan) return created;

        // ops.createIssue's own contract (AtlassianOps) doesn't guarantee `key` —
        // never call linkIssues with an undefined `from`; skip the link and say why.
        if (!key) {
          return { ...created, implements: { ok: false, to: target, error: "create response carried no issue key; link not attempted" } };
        }

        // Never let a link failure surface as if the create failed — an agent
        // that retries a "failed" create makes a duplicate ticket. The key is
        // always returned; only the link outcome can be ok:false. Unlike
        // jira_link_issues, this path never returns the op's resolved value to
        // the caller, so KAN-764's empty-201-body case needs no substitution
        // here — only a REJECTION distinguishes a link failure on this path.
        try {
          await ops.linkIssues(key, target!, "Implements");
          return { ...created, key, implements: { ok: true, to: target } };
        } catch (e) {
          return { ...created, key, implements: { ok: false, to: target, error: (e as Error).message } };
        }
      },
    },
    jira_set_priority: {
      description: "Set a Jira issue's priority by name. For a boss re-prioritizing its children as reality shifts — YOUR OWN priority is set by your boss, so never call this on your own ticket.",
      input: { key: z.string(), priority: z.string() },
      handler: (a, c) => {
        const { key, priority } = a as { key: string; priority: string };
        audit(c, `priority ${key} → ${priority}`);
        return ops.setPriority(key, priority).then((r) => orOk(r, { ok: true, key, priority }));
      },
    },
    confluence_create_page: {
      description:
        "Create a Confluence page (storage/XHTML body) in a space. Pass raw XHTML tags in `body`, NOT entity-escaped text — write <h2>Heading</h2>, never &lt;h2&gt;Heading&lt;/h2&gt;; escaped text renders on the page as literal escaped tags, not as formatting. Optional `parentId` nests the new page under that page id; omitted, Confluence files it under the space's own default parent (unchanged from today).",
      input: { spaceId: z.string(), title: z.string(), body: z.string(), parentId: z.string().optional() },
      handler: (a, c) => {
        const p = a as { spaceId: string; title: string; body: string; parentId?: string };
        audit(c, `page "${p.title}"${p.parentId ? ` under ${p.parentId}` : ""}`);
        return ops.createPage(p);
      },
    },
    confluence_update_page: {
      description:
        "Full-body replace of an existing Confluence page (storage/XHTML). Pass raw XHTML tags in `body`, NOT entity-escaped text — write <h2>Heading</h2>, never &lt;h2&gt;Heading&lt;/h2&gt;. Optimistic locking (Confluence's version number) is handled INTERNALLY — never pass or compute a version yourself. Omit `title` to keep the page's current title. Convention entries stay one-page-per-entry, never edited — this tool is for maintaining a standing page (like a convention/reference page), not for rewriting log entries.",
      input: { id: z.string(), body: z.string(), title: z.string().optional() },
      handler: (a, c) => {
        const p = a as { id: string; body: string; title?: string };
        audit(c, `update page ${p.id}${p.title ? ` (retitle "${p.title}")` : ""}`);
        return ops.updatePage(p).then((r) => orOk(r, { ok: true, id: p.id }));
      },
    },
    confluence_search_pages: {
      description:
        'Find Confluence pages without the UI. Pass `titleContains` (a plain substring — CQL is built for you, quotes escaped) and/or a raw `cql` string (used as-is when given; `titleContains`/space scoping are ignored alongside it — put everything you need in the raw query yourself). Scope by space with `spaceKey` (preferred) or `spaceId` (resolved to a key via a spaces lookup first — CQL only filters by key) — scoping only applies when building from `titleContains`, not alongside raw `cql`. `limit` defaults to 25. Each hit returns `id`, `title`, and `webui` (a relative link) — pass the `id` to confluence_get_page to read it.',
      input: {
        titleContains: z.string().optional(), cql: z.string().optional(),
        spaceId: z.string().optional(), spaceKey: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      handler: async (a, c) => {
        const p = a as { titleContains?: string; cql?: string; spaceId?: string; spaceKey?: string; limit?: number };
        if (!p.titleContains && !p.cql) {
          throw new Error("confluence_search_pages: pass `titleContains` or `cql` — at least one is required");
        }
        const escape = (s: string) => s.replace(/"/g, '\\"');
        let cql: string;
        if (p.cql) {
          cql = p.cql;
        } else {
          const clauses = [`title ~ "${escape(p.titleContains!)}"`];
          if (p.spaceKey) {
            clauses.push(`space = "${escape(p.spaceKey)}"`);
          } else if (p.spaceId) {
            // CQL's `space` field takes a key, never a numeric id (confirmed against
            // Atlassian's CQL field reference) — resolve id -> key via the spaces list
            // rather than emit a clause that would silently match nothing.
            const spaces = (await ops.listSpaces()) as { results?: Array<{ id?: string; key?: string }> };
            const match = spaces?.results?.find((s) => s.id === p.spaceId);
            if (!match?.key) throw new Error(`confluence_search_pages: no space found with id ${p.spaceId}`);
            clauses.push(`space = "${escape(match.key)}"`);
          }
          cql = clauses.join(" AND ");
        }
        audit(c, `search ${cql.slice(0, 80)}`);
        const result = (await ops.searchPages(cql, p.limit ?? 25)) as {
          results?: Array<{ content?: { id?: string }; title?: string; url?: string }>;
        };
        return { results: (result?.results ?? []).map((r) => ({ id: r.content?.id, title: r.title, webui: r.url })) };
      },
    },
    confluence_get_page: {
      description:
        "Read a Confluence page by id (storage body). The result adds `bodyRequested: true` and `bodyLength` (the storage body's character count) to the usual fields — `bodyLength: 0` means the page genuinely has an empty body, distinguishable from a body the API never returned at all.",
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
