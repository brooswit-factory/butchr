import { z } from "@brooswit/thatch";
import type { ToolDef } from "@brooswit/thatch";
import type { AtlassianOps } from "./atlassian.js";
import { getDoc, setDoc } from "./docs.js";
import { aliasTag, classifyCreateIssue, classifyLinkIssues } from "./alias-audit.js";
import {
  newWorker, startWorker, shelveWorker, adoptWorker, finishWorker, prioritizeWorker, tellWorker,
  reportToBoss, askBoss, submitToBoss, finishWithoutABoss, fileWhereItBelongs, ASK_MARKER,
  type Disposition,
} from "./relationship.js";

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

/** Every one of BUTCHR-35's ten relationship verbs refuses a connection with no `x-issue`, in the same shape get_doc/set_doc already use — refusing beats resolving to an unknown caller. */
function requireCaller(c: { headers: Record<string, string> }, verb: string): string {
  const who = c.headers["x-issue"];
  if (!who) throw new Error(`${verb}: this connection has no x-issue — refusing rather than resolving to an unknown caller`);
  return who;
}

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
 * is the Story/Task assignee mapping `jira_create_issue` (and now
 * `new_worker`/`adopt_worker`) staffs by; injected rather than read from
 * config here so this module stays pure over its ops and unit-testable
 * without a config fixture.
 *
 * READS: this layer is NO LONGER free of Jira reads — that was true only
 * until BUTCHR-33 added `get_doc`/`set_doc` (which read a ticket to find or
 * create its doc), and BUTCHR-35's ten relationship verbs (below) break it
 * far more: inferring a caller's issue type, verifying "is this one of my
 * own workers" via the Implements link, and idempotency checks are ALL Jira
 * reads, on the calling path, by design. The constraint was dropped on
 * purpose: the whole point of this vocabulary is that an agent no longer
 * supplies the issue type, the assignee or the link direction — the tool has
 * to read enough to infer and verify them itself, or those decisions go back
 * to being the agent's problem, which is the thing this story exists to
 * remove. `src/daemon/index.ts`'s own read-back loop is unaffected; this
 * note is about the tool layer specifically.
 *
 * `onWrite`, when given, fires after each MUTATING tool resolves, with the
 * key(s) it wrote and the caller's `x-issue` as writer — feeds the own-write
 * ledger (src/jira-watch/own-writes.ts) so the notify loop can recognize its
 * own echoes. Omitted when the caller's `x-issue` is missing (an
 * untagged/human call) — we never record a write under an unknown writer.
 *
 * ALIAS POLICY (BUTCHR-35): the ten relationship verbs below — new_worker,
 * start_worker, shelve_worker, adopt_worker, finish_worker,
 * prioritize_worker, tell_worker, report_to_boss, ask_boss, submit_to_boss —
 * replace the generic verbs an agent used to reach for by hand. Every
 * PRE-EXISTING name keeps working, unchanged, because a tool surface reaches
 * only newly spawned agents — one mid-task when this deploys keeps the tool
 * list it started with, and removing a name out from under it takes its
 * hands off mid-sentence. `jira_get_issue`, `jira_search`, `jira_add_comment`
 * (the deliberate SIDEWAYS channel — two bosses coordinating have no
 * relationship verb, since the hierarchy only models up and down), and
 * `confluence_list_spaces`/`confluence_search_pages` (space-wide discovery,
 * not an act inside a relationship) are RETAINED PERMANENTLY: no deprecation
 * note, not on any removal clock. Every other pre-existing name is now an
 * ALIAS — same behavior, a deprecation note in its description naming the
 * verb that replaces it, and its audit line names that verb too, so removal
 * is an evidence-based decision (zero alias calls across a full fleet
 * lifetime after a respawn — see the glossary page) rather than a guess.
 * Nothing is removed in this release.
 */
export function atlassianTools(
  ops: AtlassianOps,
  log: (line: string) => void = console.error,
  roles: AssigneeRoles = {},
  onWrite?: (keys: readonly string[], writer: string) => void,
): Record<string, ToolDef<any>> {
  const audit = (c: { headers: Record<string, string> }, what: string) =>
    log(`  [tools] ${c.headers["x-issue"] ?? "?"} → ${what}`);
  const noted = (c: { headers: Record<string, string> }, keys: readonly string[]) => {
    const writer = c.headers["x-issue"];
    if (writer) onWrite?.(keys, writer);
  };
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
      description: "DEPRECATED for the boss/worker Implements case — use new_worker (new ticket) or adopt_worker (existing ticket), which make this link for you and infer the direction. Still the only way to make a NON-Implements link (Blocks, Relates, …) or to fix up an Implements link by hand. Link two issues. The IMPLEMENTER is `from` — the outward side: task implements story ⇒ from=task, to=story; story implements epic ⇒ from=story, to=epic. This link is what routes a ticket's events (In Review, comments) to its boss — nothing else is listened to (the Jira parent field is membership only). Defaults to type \"Implements\"; pass an explicit `type` for other link kinds (Blocks, Relates, …).",
      input: { from: z.string(), to: z.string(), type: z.string().default("Implements") },
      handler: (a, c) => {
        const { from, to, type } = a as { from: string; to: string; type?: string };
        const resolvedType = type ?? "Implements";
        const cls = classifyLinkIssues(resolvedType);
        const note = cls === "sanctioned"
          ? "non-Implements link type; still the only route for it"
          : "Implements-type call; either drift toward new_worker/adopt_worker or a deliberate boss-reassignment override — not distinguishable from arguments alone";
        audit(c, `link ${from} → ${to} (${resolvedType}) — ${note} ${aliasTag("jira_link_issues", cls)}`);
        return ops.linkIssues(from, to, resolvedType).then((r) => {
          noted(c, [from, to]); // a link bumps `updated` on BOTH ends
          return orOk(r, { ok: true, from, to, type: resolvedType });
        });
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
        return ops.addComment(key, body).then((r) => { noted(c, [key]); return r; });
      },
    },
    jira_transition: {
      description:
        'DEPRECATED — use the relationship verb for what you\'re actually doing: start_worker (→ In Progress on your own worker), finish_worker (→ Done on your own worker), shelve_worker (→ To Do + the exemption label + a reason, on your own worker), submit_to_boss (→ In Review on your OWN ticket, no args), or finish_without_a_boss (→ Done on your OWN ticket, no args, ONLY when you have no boss). Those refuse a stranger\'s key and never make you type the status string; this one does neither. ' +
        'Move a Jira issue to a status by name, e.g. "In Progress", "In Review", "Done".',
      input: { key: z.string(), status: z.string() },
      handler: (a, c) => { const { key, status } = a as { key: string; status: string }; audit(c, `transition ${key} → ${status} [deprecated alias; use start_worker/shelve_worker/finish_worker/submit_to_boss] ${aliasTag("jira_transition", "drift")}`); return ops.transition(key, status).then((r) => { noted(c, [key]); return r; }); },
    },
    jira_create_issue: {
      description:
        "DEPRECATED for staffing a worker under your own ticket — use new_worker, which infers the issue type/assignee/project/link direction and requires a disposition so it can never leave an undeclared child. For a DELIBERATE ORPHAN (`implements: \"none\"`, explicit out-of-scope/triage work your brief tells you to file outside your epic), prefer file_where_it_belongs instead — it demands and records WHERE the work belongs and pushes a notice a person actually receives; `implements: \"none\"` here still works, unchanged, but leaves the destination undocumented and nobody notified unless you do that by hand. new_worker always links to its caller and has no orphan route either way. " +
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

        // Decided up front, from `issuetype`/`implements` alone, so every audit line below
        // (including the two REFUSED ones, before `orphan`/`target` are even resolved) agrees —
        // see classifyCreateIssue's own doc comment (src/tools/alias-audit.ts) for the rule.
        const cls = classifyCreateIssue(p.issuetype, p.implements);
        const clsTag = aliasTag("jira_create_issue", cls);

        // (1) Assign by role, regardless of parent — an explicit `assignee` always wins.
        // A refusal is still something a connection did, so it gets its own audit line
        // before the throw — otherwise the operator watching the daemon log sees nothing.
        let assignee = p.assignee;
        if (!assignee && p.issuetype !== "Epic") {
          assignee = p.issuetype === "Story" ? roles.story : roles.task;
          if (!assignee) {
            const envVar = p.issuetype === "Story" ? "BUTCHR_ASSIGNEE_STORY" : "BUTCHR_ASSIGNEE_TASK";
            audit(c, `create ${p.issuetype} under ${p.parent ?? "(none)"} REFUSED: no assignee (${envVar} unset) [deprecated alias; use new_worker] ${clsTag}`);
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
            audit(c, `create ${p.issuetype} under (none) REFUSED: no implements target [deprecated alias; use new_worker] ${clsTag}`);
            throw new Error(noTargetMsg(p.issuetype));
          }
        }

        // (4) Audit line: type/parent, resolved target ("orphan by request" for the opt-out), resolved assignee.
        // An Epic, and a deliberate orphan, have no successor at all (new_worker
        // never creates an Epic — Epics are the human's — and has no orphan
        // route by design) — SANCTIONED, not drift, even though the human-facing
        // text still says "no successor" for readability. Only the linked
        // Story/Task case, where new_worker genuinely does replace this, is DRIFT.
        let line = `create ${p.issuetype} under ${p.parent ?? "(none)"}`;
        if (p.issuetype !== "Epic") line += orphan ? " orphan by request" : ` implements ${target}`;
        if (assignee) line += ` → ${truncAccountId(assignee)}`;
        line += p.issuetype !== "Epic" && !orphan ? " [deprecated alias; use new_worker]" : " [deprecated alias; no successor for this case]";
        line += ` ${clsTag}`;
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
        if (key) noted(c, [key]); // the create itself: a new ticket's own `updated`

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
          noted(c, [key, target!]); // the link bumps `updated` on BOTH ends
          return { ...created, key, implements: { ok: true, to: target } };
        } catch (e) {
          return { ...created, key, implements: { ok: false, to: target, error: (e as Error).message } };
        }
      },
    },
    jira_set_priority: {
      description: "DEPRECATED — use prioritize_worker, which also refuses your own key (your priority is your boss's judgment, never your own) rather than leaving that as an unenforced instruction. Set a Jira issue's priority by name. For a boss re-prioritizing its children as reality shifts — YOUR OWN priority is set by your boss, so never call this on your own ticket.",
      input: { key: z.string(), priority: z.string() },
      handler: (a, c) => {
        const { key, priority } = a as { key: string; priority: string };
        audit(c, `priority ${key} → ${priority} [deprecated alias; use prioritize_worker] ${aliasTag("jira_set_priority", "drift")}`);
        return ops.setPriority(key, priority).then((r) => { noted(c, [key]); return orOk(r, { ok: true, key, priority }); });
      },
    },
    // ASSIGNEE RULE: a role name ("story"/"task", case-insensitive) resolves
    // through `roles`; anything else is passed through as a raw accountId.
    // These two cases are not cleanly separable by shape alone — any string
    // that isn't a known role name could equally be an accountId — so rather
    // than invent a fragile "looks like an accountId" regex, we only refuse
    // the case that actually indicates caller error: a role name whose
    // accountId is UNSET on this daemon. An accountId that's simply wrong
    // fails at Jira, same as it always has.
    jira_assign: {
      description:
        'DEPRECATED for staffing a boss\'s own worker — use adopt_worker, which also makes the Implements link and ensures a doc in the same call, and refuses a ticket already adopted by a different boss. Still useful for a raw reassignment that isn\'t an adoption. ' +
        'Assign an EXISTING Jira issue — for a boss adopting or re-staffing a ticket someone else already filed; never call this on your own ticket (your assignee is your boss\'s call). `assignee` is either an Atlassian accountId or a role name ("story"/"task", case-insensitive) resolved through this daemon\'s role→accountId mapping; a role whose accountId is unset on this daemon REFUSES, naming the env var. Writes only the assignee field — nothing else about the issue changes.',
      input: { key: z.string(), assignee: z.string() },
      handler: async (a, c) => {
        const { key, assignee } = a as { key: string; assignee: string };
        const role = assignee.trim().toLowerCase();
        let accountId: string;
        let label: string;
        if (role === "story" || role === "task") {
          const resolved = role === "story" ? roles.story : roles.task;
          if (!resolved) {
            const envVar = role === "story" ? "BUTCHR_ASSIGNEE_STORY" : "BUTCHR_ASSIGNEE_TASK";
            audit(c, `assign ${key} → ${role} REFUSED: no assignee (${envVar} unset) [deprecated alias; use adopt_worker] ${aliasTag("jira_assign", "ambiguous")}`);
            throw new Error(`jira_assign: no assignee for role "${role}" — set ${envVar} (an Atlassian accountId) on this daemon, or pass an explicit accountId`);
          }
          accountId = resolved;
          label = role;
        } else {
          accountId = assignee;
          label = truncAccountId(assignee);
        }
        audit(c, `assign ${key} → ${label} [deprecated alias; use adopt_worker — unless this is a raw reassignment that isn't an adoption, which stays sanctioned] ${aliasTag("jira_assign", "ambiguous")}`);
        return ops.assign(key, accountId).then((r) => { noted(c, [key]); return orOk(r, { ok: true, key, assignee: accountId }); });
      },
    },
    confluence_create_page: {
      description:
        "DEPRECATED for a ticket's own doc — use set_doc, which finds/creates and nests the caller's own doc under its boss's automatically; there is no key parameter, so it can never target another ticket's doc. Still the general-purpose way to create a page that ISN'T a ticket's doc. " +
        "Create a Confluence page (storage/XHTML body) in a space. Pass raw XHTML tags in `body`, NOT entity-escaped text — write <h2>Heading</h2>, never &lt;h2&gt;Heading&lt;/h2&gt;; escaped text renders on the page as literal escaped tags, not as formatting. Optional `parentId` nests the new page under that page id; omitted, Confluence files it under the space's own default parent (unchanged from today).",
      input: { spaceId: z.string(), title: z.string(), body: z.string(), parentId: z.string().optional() },
      handler: (a, c) => {
        const p = a as { spaceId: string; title: string; body: string; parentId?: string };
        audit(c, `page "${p.title}"${p.parentId ? ` under ${p.parentId}` : ""} [deprecated alias; use set_doc for a ticket's own doc — unless this page isn't a ticket's doc, which stays sanctioned] ${aliasTag("confluence_create_page", "ambiguous")}`);
        return ops.createPage(p);
      },
    },
    confluence_update_page: {
      description:
        "DEPRECATED for a ticket's own doc — use set_doc, a full-body replace of the CALLER's own doc with no key parameter at all. Still the general-purpose way to update a standing page (like a convention/reference page) that ISN'T a ticket's doc. " +
        "Full-body replace of an existing Confluence page (storage/XHTML). Pass raw XHTML tags in `body`, NOT entity-escaped text — write <h2>Heading</h2>, never &lt;h2&gt;Heading&lt;/h2&gt;. Optimistic locking (Confluence's version number) is handled INTERNALLY — never pass or compute a version yourself. Omit `title` to keep the page's current title. Convention entries stay one-page-per-entry, never edited — this tool is for maintaining a standing page (like a convention/reference page), not for rewriting log entries.",
      input: { id: z.string(), body: z.string(), title: z.string().optional() },
      handler: (a, c) => {
        const p = a as { id: string; body: string; title?: string };
        audit(c, `update page ${p.id}${p.title ? ` (retitle "${p.title}")` : ""} [deprecated alias; use set_doc for a ticket's own doc — unless this page isn't a ticket's doc, which stays sanctioned] ${aliasTag("confluence_update_page", "ambiguous")}`);
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
        "DEPRECATED for a ticket's own doc — use get_doc, which resolves the page id for you (the caller's own by default, or another ticket's by key) instead of making you discover and hand-carry a page id. Still the general-purpose way to read a page that ISN'T reached through a ticket. " +
        "Read a Confluence page by id (storage body). The result adds `bodyRequested: true` and `bodyLength` (the storage body's character count) to the usual fields — `bodyLength: 0` means the page genuinely has an empty body, distinguishable from a body the API never returned at all.",
      input: { id: z.string() },
      handler: (a, c) => { const { id } = a as { id: string }; audit(c, `read page ${id} [deprecated alias; use get_doc for a ticket's own doc — unless this page isn't a ticket's doc, which stays sanctioned] ${aliasTag("confluence_get_page", "ambiguous")}`); return ops.getPage(id); },
    },
    confluence_list_spaces: {
      description: "List Confluence spaces (to find a spaceId).",
      input: {},
      handler: (_a, c) => { audit(c, "list spaces"); return ops.listSpaces(); },
    },
    get_doc: {
      description:
        'Read a ticket\'s doc — the CALLER\'s own by default, or another ticket\'s when `key` is given (e.g. a boss reading a worker\'s doc at review time). Reads are unrestricted by ownership: reading any ticket\'s doc for context is fine. WRITES NOTHING, EVER, for self or for another ticket — a ticket with no doc yet resolves to `{ found: false }`, never an error and never a lazily-created page; use set_doc to create/write your own doc. On a hit, returns `{ found: true, id, url, title, body }`.',
      input: { key: z.string().optional() },
      handler: async (a, c) => {
        const { key } = a as { key?: string };
        const who = c.headers["x-issue"];
        if (!who) throw new Error("get_doc: this connection has no x-issue — refusing rather than resolving to an unknown caller");
        const target = key ?? who;
        audit(c, `get_doc ${target}${key ? "" : " (self)"}`);
        return getDoc(ops, target);
      },
    },
    set_doc: {
      description:
        'FULL-BODY REPLACE of the CALLER\'S OWN doc. READ THIS FIRST: this is REPLACE, not APPEND — an agent that treats `set_doc` as "append" destroys its own page on the very first call. Call get_doc() first, edit the body you got back, then write the whole thing. There is NO KEY PARAMETER AT ALL: this can only ever write the caller\'s own doc, identified by `x-issue` — overwriting another ticket\'s doc is not expressible by getting an argument wrong. Ensures the doc exists first (creating it lazily, nested under the boss\'s doc, or the project root doc when there is no boss) then writes. `title` is optional ONCE the doc has a real title (omitting it keeps the current one) — but while the current title still carries the "[unwritten]" provisional marker, `title` is REQUIRED: you cannot write real content and leave the page looking unwritten.',
      input: { body: z.string(), title: z.string().optional() },
      handler: async (a, c) => {
        const { body, title } = a as { body: string; title?: string };
        const who = c.headers["x-issue"];
        if (!who) throw new Error("set_doc: this connection has no x-issue — refusing rather than resolving to an unknown caller");
        audit(c, `set_doc ${who}${title ? ` (retitle "${title}")` : ""}`);
        const result = await setDoc(ops, who, body, title);
        noted(c, [who]); // the remote-link upsert bumps the ticket's own `updated`
        return result;
      },
    },

    // -------------------------------------------------------------------
    // BUTCHR-35: the ten relationship-shaped verbs. Every one below refuses
    // a connection with no `x-issue`, in the same shape get_doc/set_doc use
    // — refusing beats resolving to an unknown caller. `src/tools/
    // relationship.ts` holds the actual logic (ownership checks, inference,
    // the new_worker write order); these are thin wiring, same split as
    // get_doc/set_doc over docs.ts.
    // -------------------------------------------------------------------
    new_worker: {
      description:
        "Create a worker one tier below the CALLER: an Epic's new_worker makes a Story, a Story's makes a Task — a Task has no worker beneath it and this REFUSES for a Task caller, explaining in words that it has reached the bottom of the hierarchy. " +
        "YOU SUPPLY: `summary`, `description` (the full context a fresh agent needs to meet the definition of done), `priority` (optional — omitting it takes the site default), and a REQUIRED `disposition`: `\"start\"`, or `\"shelve\"` with a non-empty `reason` (the activation condition, in words — a `shelve` with no reason is REFUSED, and so is a missing disposition entirely; there is no default and no third option, because a worker this tool creates is always RUNNING or SHELVED, never undeclared). " +
        "INFERRED, WITH NO ARGUMENT FOR ANY OF IT: the child's issue type (from your own type, per the rule above), the assignee (from this daemon's role map — REFUSED if that role's accountId is unset, naming the missing env var), the project (from your own), the link direction (Implements, outward from the new child to you, never the reverse), and the new doc's parent page (your own doc). " +
        "WHAT A RETURNED RESULT GUARANTEES, AND WHAT A THROWN ERROR MEANS — READ THIS BEFORE TREATING EITHER AS DONE: writes happen in the order create → Implements link → disposition → doc, each step chosen to be less harmful to stop at than the last. A NORMAL RETURN ALWAYS MEANS a ticket that has a boss (the link succeeded), a declared disposition (RUNNING or SHELVED, never undeclared) AND a doc. If ONLY the doc step failed, this THROWS rather than returning a partial result — but by then the ticket, its boss link and its disposition are ALL already real and are NOT rolled back; the error names the surviving key, and its doc is completed by that ticket's own first `set_doc` call, whenever the agent working it makes one. Nothing here retries or fixes it automatically: a ticket that never gets a `set_doc` call simply has no doc until something calls for that key — strictly better than a duplicate or an orphan, but not invisible, and not something a caller should infer from a successful-looking throw. " +
        "ON FAILURE AFTER THE TICKET IS CREATED (the link or the disposition write): this attempts to delete the ticket it just created and rethrows either way — \"rolled back, nothing survives\" if the delete succeeded, or a NAMED PARTIAL STATE (the surviving ticket key) if it didn't. This is NOT unconditional atomicity: as of BUTCHR-35 this daemon's own credential does not hold Jira's `DELETE_ISSUES` permission on this project (measured — a permission read and a live round trip both confirm it), so the delete is currently expected to fail when attempted; it is attempted anyway because the refusal is a permission, not an API limit, and this exact code becomes fully self-cleaning the day that permission is granted, on whichever deployment holds it. Never assume a failure left nothing behind — read the error, which always names what survived. " +
        "Replaces jira_create_issue plus the confluence_create_page call and the doc-linking step a careful agent did by hand. Does NOT cover filing a deliberate orphan (`implements: \"none\"`) — that stays on jira_create_issue, which remains the only route for out-of-scope work your brief tells you to file outside your epic.",
      input: {
        summary: z.string(),
        description: z.string().optional(),
        priority: z.string().optional(),
        disposition: z.enum(["start", "shelve"]),
        reason: z.string().optional(),
      },
      handler: async (a, c) => {
        const p = a as { summary: string; description?: string; priority?: string; disposition: "start" | "shelve"; reason?: string };
        const who = requireCaller(c, "new_worker");
        const disposition: Disposition = p.disposition === "shelve" ? { kind: "shelve", reason: p.reason ?? "" } : { kind: "start" };
        audit(c, `new_worker disposition=${p.disposition}${p.priority ? ` priority=${p.priority}` : ""}`);
        const result = await newWorker(ops, roles, who, {
          summary: p.summary,
          ...(p.description ? { description: p.description } : {}),
          ...(p.priority ? { priority: p.priority } : {}),
          disposition,
        });
        noted(c, [result.key, who]); // the new ticket's own `updated`, plus the Implements link bumping the caller's
        return result;
      },
    },
    start_worker: {
      description:
        "Move ONE OF THE CALLER'S OWN workers to In Progress — the call that actually staffs an agent for it (an assigned-but-To-Do ticket is not staffed, and a boss waiting on events from it waits forever). Also reactivates a shelved worker, and sends an In Review worker back to work. Reactivating a shelved worker WITHDRAWS the shelved-exemption label if the worker carries it — the label means CURRENTLY shelved, a state, not a history, so the verb that reverses a shelve is the verb that retires it — cleared BEFORE the transition, never after (a live ticket left silently carrying a stale exemption is the failure this ordering exists to rule out), and skipped entirely, at no extra Jira call, when the worker doesn't carry it. Refuses a `key` that is not one of the caller's own workers, verified fresh via the Implements link (never a stale snapshot). Replaces jira_transition(key, \"In Progress\") for this case.",
      input: { key: z.string() },
      handler: async (a, c) => {
        const { key } = a as { key: string };
        const who = requireCaller(c, "start_worker");
        audit(c, `start_worker ${key}`);
        const r = await startWorker(ops, who, key);
        noted(c, [key]);
        return orOk(r, { ok: true, key, status: "In Progress" });
      },
    },
    shelve_worker: {
      description:
        "Deliberately put ONE OF THE CALLER'S OWN workers down, with the intention recorded: moves it to To Do, ADDS the shelved-exemption label (additively — never drops labels the ticket already carries; the exact label is read out of the parked-ticket detector's own code, so it always matches what that detector checks for), and posts `reason` as a comment — ALL IN ONE CALL, because a two-step declaration recreates the exact multi-step failure this epic exists to kill. Refuses a `key` that is not one of the caller's own workers, and refuses an empty `reason` — a reader six weeks from now must be able to tell a shelved ticket from a forgotten one without asking an agent that no longer exists. If you already know at filing time that a new or adopted ticket should be shelved, prefer new_worker/adopt_worker's own `disposition: \"shelve\"` — the label lands in the very call that creates the ticket, so there's no second call to forget. Has no predecessor: shelving was previously only an intention in an agent's head.",
      input: { key: z.string(), reason: z.string() },
      handler: async (a, c) => {
        const { key, reason } = a as { key: string; reason: string };
        const who = requireCaller(c, "shelve_worker");
        audit(c, `shelve_worker ${key}`);
        await shelveWorker(ops, who, key, reason);
        noted(c, [key]);
        return { ok: true, key, status: "To Do" };
      },
    },
    adopt_worker: {
      description:
        "Take ownership of an EXISTING ticket — an orphan, or one filed by an agent that has since ended: infers the assignee from the ADOPTED ticket's own issue type (Story or Task; anything else is refused), makes the Implements link (adopted ticket → caller), and ensures its doc, nested under the caller's own. Also takes the SAME required `disposition` as new_worker (`\"start\"`, or `\"shelve\"` with a non-empty `reason`) — an adopted ticket left in To Do with nobody's decision recorded is the same undeclared state as an unstarted new_worker child, by a different door. IDEMPOTENT: adopting a ticket already correctly adopted by the caller changes nothing (the assign/link/disposition writes are skipped) and is NOT an error — only the doc is still ensured, as a no-op-when-already-present safety net. A `\"start\"` disposition ALSO WITHDRAWS the shelved-exemption label whenever the adopted ticket carries it, and this clear is NOT gated on that idempotence check — even an otherwise fully idempotent re-adoption (already linked, already assigned, already In Progress) still clears a stale exemption, because a live ticket silently carrying one is the same residue start_worker exists to stop producing, through a second door. No extra Jira call: it reuses the labels this call already fetched to decide idempotence. A `\"shelve\"` disposition only ever adds the label — it never clears one. REFUSES a ticket already linked to a DIFFERENT boss — stealing another boss's worker must be an explicit act (jira_link_issues), never a side effect of a mistyped key. Replaces jira_assign plus a hand-written jira_link_issues call, plus the doc creation nobody remembered.",
      input: {
        key: z.string(),
        disposition: z.enum(["start", "shelve"]),
        reason: z.string().optional(),
      },
      handler: async (a, c) => {
        const p = a as { key: string; disposition: "start" | "shelve"; reason?: string };
        const who = requireCaller(c, "adopt_worker");
        const disposition: Disposition = p.disposition === "shelve" ? { kind: "shelve", reason: p.reason ?? "" } : { kind: "start" };
        audit(c, `adopt_worker ${p.key} disposition=${p.disposition}`);
        const result = await adoptWorker(ops, roles, who, p.key, disposition);
        noted(c, [p.key, who]);
        return result;
      },
    },
    finish_worker: {
      description:
        "Close ONE OF THE CALLER'S OWN workers: moves it to Done. This is the boss's closing act, AFTER reviewing what it actually delivered (including that its doc reflects what actually shipped — staleness that reads as authoritative is the failure mode). Also WITHDRAWS the shelved-exemption label first, if the worker carries it — cleared BEFORE the transition, same ordering as start_worker's — because Done is not shelved: a finished ticket still carrying the exemption is residue, not state. Skipped entirely, at no extra Jira call, when the label isn't present. Refuses a `key` that is not one of the caller's own workers. A worker never finishes itself — see submit_to_boss; the review hop is the entire point of the asymmetry. Replaces jira_transition(key, \"Done\") for this case.",
      input: { key: z.string() },
      handler: async (a, c) => {
        const { key } = a as { key: string };
        const who = requireCaller(c, "finish_worker");
        audit(c, `finish_worker ${key}`);
        const r = await finishWorker(ops, who, key);
        noted(c, [key]);
        return orOk(r, { ok: true, key, status: "Done" });
      },
    },
    prioritize_worker: {
      description:
        "Revise ONE OF THE CALLER'S OWN workers' priority — a boss's judgment of what matters NOW, not only at filing. Refuses a `key` that is not one of the caller's own workers, AND — distinctively — refuses the CALLER'S OWN key: your priority is your boss's judgment, never your own, and this makes that a refusal instead of an unenforced sentence in a brief. Replaces jira_set_priority for this case.",
      input: { key: z.string(), priority: z.string() },
      handler: async (a, c) => {
        const { key, priority } = a as { key: string; priority: string };
        const who = requireCaller(c, "prioritize_worker");
        audit(c, `prioritize_worker ${key} → ${priority}`);
        const r = await prioritizeWorker(ops, who, key, priority);
        noted(c, [key]);
        return orOk(r, { ok: true, key, priority });
      },
    },
    tell_worker: {
      description:
        `The ONLY way to speak DOWN to a worker: comments on ONE OF THE CALLER'S OWN workers' ticket. Refuses a \`key\` that is not one of the caller's own workers, verified via the Implements link — the failure this exists to prevent is a boss commenting on a stranger's ticket because one character of a key was wrong. THE HIGHEST-CONSEQUENCE MESSAGES IN THIS FLEET TRAVEL HERE: the \`[review] APPROVED <pr-url> @ <sha>\` / \`[review] CHANGES_REQUESTED\` lines that wake a PR author, and the \`ANSWER <n> <fingerprint>\` reply that unfreezes a worker blocked on a dialog — an agent that doesn't know this reaches for jira_add_comment instead, and its worker never wakes up. Replaces jira_add_comment(key, text) for the downward case ONLY — jira_add_comment remains the deliberate SIDEWAYS channel for two bosses coordinating (which this refuses, by design) and stays permanent for that.`,
      input: { key: z.string(), text: z.string() },
      handler: async (a, c) => {
        const { key, text } = a as { key: string; text: string };
        const who = requireCaller(c, "tell_worker");
        audit(c, `tell_worker ${key}`);
        const r = await tellWorker(ops, who, key, text);
        noted(c, [key]);
        return r;
      },
    },
    report_to_boss: {
      description:
        'Comment on the CALLER\'S OWN ticket — the routing a boss actually listens to. THERE IS NO KEY PARAMETER, AND THERE MUST NEVER BE ONE: a boss listens to its workers\' tickets, so a comment written onto the BOSS\'s own ticket routes one tier too high — the empty arg list settles that question faster than any name could ("report_to_boss" sounds like it writes to the boss\'s ticket; it must not). Refuses nothing else — a verb with no key has no key to get wrong. Replaces jira_add_comment(my_own_key, text).',
      input: { text: z.string() },
      handler: async (a, c) => {
        const { text } = a as { text: string };
        const who = requireCaller(c, "report_to_boss");
        audit(c, `report_to_boss`);
        const r = await reportToBoss(ops, who, text);
        noted(c, [who]);
        return r;
      },
    },
    ask_boss: {
      description:
        `Same channel as report_to_boss — a comment on the CALLER'S OWN ticket, no key parameter — but marked with the literal \`${ASK_MARKER}\` right after the identity tag, so a boss can find its workers' UNANSWERED questions without reading every comment they wrote. ASKING DOES NOT CHANGE THE ASKER'S STATUS — an agent that asks and can still make progress should carry on; one that genuinely cannot proceed is a different situation (the daemon's own blocked-dialog escalation handles that). Use report_to_boss for information; use this only when there's a real outstanding answer you're waiting on.`,
      input: { text: z.string() },
      handler: async (a, c) => {
        const { text } = a as { text: string };
        const who = requireCaller(c, "ask_boss");
        audit(c, `ask_boss`);
        const r = await askBoss(ops, who, text);
        noted(c, [who]);
        return r;
      },
    },
    submit_to_boss: {
      description:
        'Move the CALLER\'S OWN ticket to In Review — the event that wakes the caller\'s boss. TAKES NO ARGUMENTS AT ALL: this is the one transition an agent is always entitled to make about itself. A worker never moves itself to Done — reaching Done needs a second identity to have looked, which is the review hop finish_worker exists for. Replaces jira_transition(my_own_key, "In Review").',
      input: {},
      handler: async (_a, c) => {
        const who = requireCaller(c, "submit_to_boss");
        audit(c, `submit_to_boss`);
        const r = await submitToBoss(ops, who);
        noted(c, [who]);
        return orOk(r, { ok: true, key: who, status: "In Review" });
      },
    },
    finish_without_a_boss: {
      description:
        "Move the CALLER'S OWN ticket to Done — but ONLY when the caller has NO BOSS at all (today, in practice, an Epic). TAKES NO ARGUMENTS AT ALL, same reasoning as submit_to_boss: the only ticket this can ever act on is the caller's own, so there is nothing to get wrong. " +
        "REFUSES any caller that HAS a boss — that refusal IS this verb's entire purpose, not a guard bolted onto it: a worker never finishes itself (see finish_worker), and a caller with a boss already has the review hop that guarantee depends on waiting for it — submit_to_boss, then that boss's own finish_worker. The refusal names the boss, says to use submit_to_boss instead, and says why: every Done in this system requires a second identity to have looked at the work first, except this one deliberate, narrow exception for a ticket that has nobody to submit to and nobody who will ever call finish_worker on it. " +
        "Replaces jira_transition(my_own_key, \"Done\") for the top-level, bossless case ONLY — jira_transition remains an alias for every other transition it can still make. " +
        "DESIGNED TO NARROW TO NOTHING ON ITS OWN, NOT TO BE REMOVED: a planned tier above epics does not exist yet; if it did, every top-level ticket would have a boss and this verb would simply stop having callers, with no removal needed — a ticket with a boss can never use it. Whether a top-level ticket SHOULD be able to close itself at all, with no second identity ever looking, is an open question this verb does not settle and is not its call to settle — that belongs to whoever decides if and when that tier gets built.",
      input: {},
      handler: async (_a, c) => {
        const who = requireCaller(c, "finish_without_a_boss");
        audit(c, `finish_without_a_boss`);
        const r = await finishWithoutABoss(ops, who);
        noted(c, [who]);
        return orOk(r, { ok: true, key: who, status: "Done" });
      },
    },
    file_where_it_belongs: {
      description:
        "The successor to jira_create_issue's `implements: \"none\"` deliberate-orphan escape (still an unchanged alias this release). Files a ticket that is explicitly NOT the caller's — genuine out-of-scope work your brief tells you to file outside your own epic. NO Implements link is ever made, to the destination or to anything else: this stays a true orphan. " +
        "YOU SUPPLY: `summary`, `description` (optional), `issuetype` (`\"Story\"` or `\"Task\"`), `priority` (optional — omitting it takes the site default), and a REQUIRED `destination`. " +
        "`destination` IS EITHER: an EXISTING EPIC KEY this work belongs under (e.g. \"BUTCHR-25\"), OR a short prose REASON it needs a brand-new epic (e.g. \"no epic covers observability tooling yet\") — both are legitimate, neither is a fallback for the other. REFUSED: an empty or whitespace-only destination; a placeholder (\"n/a\", \"tbd\", \"unknown\", \"none\", \"?\", \"-\", \"idk\", and the like); a Jira-key-shaped destination that doesn't exist, or that exists but isn't an Epic (naming what it actually is); and prose too thin to be a real reason. This is the point of the tool, not an obstacle to route around: filing work outside your scope is only half the job, saying where it should live is the other half. " +
        "TAKES NO DISPOSITION, unlike new_worker/adopt_worker — argued, not omitted: a disposition answers \"what happens to MY worker\", and nobody can answer that for a ticket that is by definition not yours. It is filed To Do, staffed by role exactly as jira_create_issue staffs it today, and stays there — never staffed by this daemon — until some future boss calls adopt_worker on it. Never carries the shelved-exemption label: the parked-ticket detector only ever walks tickets reachable by an Implements link, and this ticket has none, so that label would mean nothing here. " +
        "WHAT IT WRITES: the created ticket's OWN description gets a destination header block baked in at creation (never only in a comment) plus the `butchr:orphan` label (a one-line JQL away from \"show me every undirected ticket\"); then a best-effort NOTICE comment — on the named epic (case A), or, when the destination is a \"needs a new epic\" reason, on the TOPMOST ticket in the CALLER's own Implements chain (case B, since there's no epic yet to comment on and this daemon has no configured human/root key). CASE B CREATES NO LINK: the notice says where the filer thinks the work belongs, it does not make it so — quietly re-parenting an orphan onto whatever it lands near would be exactly the suppression this verb exists to prevent. " +
        "ORDER AND WHAT A THROW MEANS: create (destination + label already baked in) happens first and is irreversible; the notice and the doc (ensureDoc, same as new_worker) are best-effort afterward. A THROW after creation means the ticket itself is fine and needs no cleanup — the error names exactly which of the notice/doc failed and how to complete it by hand (jira_add_comment for the notice; the ticket's own first set_doc call for the doc). " +
        "Was named `file_for_another_boss` during design; renamed before shipping because that name asserts there IS another boss, which is false in the \"needs a new epic\" case.",
      input: {
        summary: z.string(),
        description: z.string().optional(),
        issuetype: z.enum(["Story", "Task"]),
        priority: z.string().optional(),
        destination: z.string(),
      },
      handler: async (a, c) => {
        const p = a as { summary: string; description?: string; issuetype: "Story" | "Task"; priority?: string; destination: string };
        const who = requireCaller(c, "file_where_it_belongs");
        audit(c, `file_where_it_belongs issuetype=${p.issuetype} destination="${p.destination.slice(0, 60)}"`);
        const result = await fileWhereItBelongs(ops, roles, who, {
          summary: p.summary,
          ...(p.description ? { description: p.description } : {}),
          issuetype: p.issuetype,
          ...(p.priority ? { priority: p.priority } : {}),
          destination: p.destination,
        });
        noted(c, [result.key, result.noticeTarget]); // the new ticket's own `updated`, plus the notice bumping its target's
        return result;
      },
    },
  };
}
