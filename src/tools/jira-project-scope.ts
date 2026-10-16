/**
 * FACTORY-732 (implementing FACTORY-721): a project-scoped Jira allowlist
 * for `jira-project` ("manager") sessions — a callerIdentity whose
 * `resource` is a Jira PROJECT key (src/mcp/identity.ts), not a single
 * ticket. Before this, `forJiraCallers` (src/tools/github-issue.ts) refused
 * every `jira-project` call outright, same as a `github-issue`/`jira-idea`
 * agent. This module carves out a narrow, explicit exception: a
 * `jira-project` caller may use FOUR Jira tools, each scoped to its OWN
 * project, and nothing else.
 *
 * HONEST FRAMING (FACTORY-721 requirement 6): `x-butchr-agent` is a plain,
 * forgeable header — any MCP client can send one naming any project. This
 * gate is a GUARDRAIL against an honest agent's own mistakes (wrong key,
 * stray cross-project JQL), NOT containment against a hostile one. Nothing
 * here authenticates the header's sender.
 *
 * THE ALLOWLIST (FACTORY-721 requirement 2): a single, deliberately short,
 * easily-edited array — `JIRA_PROJECT_MANAGER_TOOLS` below. Confluence
 * reads (`confluence_get_page`, `confluence_search_pages`) are named in
 * FACTORY-721's own description as a future candidate, but its decisive
 * comment removes them for v1 because no per-project Confluence scope
 * exists yet (a Confluence space isn't a Jira project key, and
 * `identity.resource` only carries the latter) — adding them later, once
 * that scope exists, is meant to be a one-line addition to this array, not
 * a redesign of this file.
 */
import type { ToolDef } from "@brooswit/thatch";
import { callerIdentity } from "../mcp/identity.js";
import type { AtlassianOps } from "./atlassian.js";
import { JIRA_KEY_RE } from "./docs.js";
import { Refusal } from "./outcome.js";

/**
 * The ONLY tool names a `jira-project` caller may ever reach. Every other
 * registered tool — `jira_create_issue`, `jira_assign`, `jira_set_priority`,
 * `jira_link_issues`, `add_link`, `remove_link`, `freeze_session`,
 * `confluence_create_page`, `confluence_update_page`, `set_doc`, every
 * boss/worker relationship verb, and anything added later — is refused for
 * this caller by `restrictJiraProjectManagers` below purely by NOT being in
 * this list; nothing else needs to name them one by one.
 */
export const JIRA_PROJECT_MANAGER_TOOLS: readonly string[] = [
  "jira_get_issue",
  "jira_search",
  "jira_add_comment",
  "jira_transition",
];

/** Reads a Jira issue's CURRENT project key off a `getIssue` response — the same shape `projectKeyOf` (src/tools/relationship.ts) reads, duplicated here rather than imported since that one is module-private. */
function currentProjectOf(issue: unknown): string | undefined {
  return (issue as { fields?: { project?: { key?: string } } })?.fields?.project?.key;
}

/**
 * A single quote/paren-aware scan of a caller's JQL, feeding both scoping
 * defects a review (FACTORY-732) found in the FIRST version of the
 * `jira_search` wrapper:
 *   - PAREN BREAKOUT: `project = X AND (<jql>)` is unsafe if `<jql>` itself
 *     carries an unbalanced parenthesis — `x) OR project = OTHER OR (y`
 *     wraps into `project = X AND (x) OR project = OTHER OR (y)`, and `AND`
 *     binds tighter than the bare `OR`, so `OTHER` leaks out from under the
 *     `project = X` restriction entirely. `balanced` is false whenever a
 *     `)` closes before a matching `(` (checked live, not just at the end)
 *     or the string ends with a paren or quote still open.
 *   - ORDER BY: JQL's grammar puts `ORDER BY` OUTSIDE any parens, at the
 *     very end of the whole query — `project = X AND (<jql> ORDER BY …)`
 *     is simply invalid JQL, breaking the common case of an ordered
 *     search. `orderByIndex` names where a top-level (not inside quotes or
 *     parens) `ORDER BY` keyword starts, so the caller can hoist it OUT of
 *     the wrapped parens rather than leaving it trapped inside them — this
 *     is still "wrap, don't detect": the split only ever relocates a
 *     trailing suffix, it never inspects the body for a `project` clause.
 * Both checks share one scan so a quoted `"ORDER BY"` string literal (JQL
 * allows arbitrary text in quotes) is treated as inert text for BOTH
 * purposes, not just one.
 */
function scanJql(jql: string): { balanced: boolean; orderByIndex: number | null } {
  let depth = 0;
  let quote: string | null = null;
  let orderByIndex: number | null = null;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; } // an escaped char inside a quoted string is never structural
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth < 0) return { balanced: false, orderByIndex: null }; // closes before it ever opened — breakout attempt, stop scanning
      continue;
    }
    if (depth === 0) {
      const prevChar = jql[i - 1];
      const atWordStart = prevChar === undefined || !/\w/.test(prevChar);
      if (atWordStart && /^order\s+by\b/i.test(jql.slice(i))) orderByIndex = i;
    }
  }
  return { balanced: depth === 0 && quote === null, orderByIndex };
}

/**
 * `project = <own> AND (<jql>)` — except a trailing, top-level `ORDER BY …`
 * is hoisted OUT of the parens first (`scanJql` above), since JQL requires
 * it outside them. Refuses (never wraps) a `jql` `scanJql` finds
 * paren/quote-unbalanced, rather than producing JQL whose real grouping no
 * longer matches what the wrapper intended.
 */
function wrapJqlToProject(jql: string, ownProject: string): string {
  const { balanced, orderByIndex } = scanJql(jql);
  if (!balanced) {
    throw new Refusal(
      `jira_search: refusing a jira-project (manager) agent — its JQL has an unbalanced parenthesis or quote, which could break out of the "project = ${ownProject} AND (…)" scope wrapper`,
    );
  }
  if (orderByIndex === null) return `project = ${ownProject} AND (${jql})`;
  const body = jql.slice(0, orderByIndex).trim();
  const orderByClause = jql.slice(orderByIndex).trim();
  return body.length > 0 ? `project = ${ownProject} AND (${body}) ${orderByClause}` : `project = ${ownProject} ${orderByClause}`;
}

/**
 * Wraps a tool map so a `jira-project` caller is confined to
 * `JIRA_PROJECT_MANAGER_TOOLS`, each scoped to its OWN project
 * (`callerIdentity(...).resource`). Every OTHER caller (a `jira-work` agent,
 * a human, or any other provider `forJiraCallers` already gates) passes
 * through completely untouched — this function changes nothing for them,
 * so wrapping `resourceLinkTools`/`sessionFreezeTools`'s output with it (as
 * well as the Jira/Confluence tool set) is safe: those tools have no
 * `jira-project`-shaped caller today, and none of their names are in the
 * allowlist, so every `jira-project` call into them is refused exactly like
 * any other non-allowlisted verb.
 *
 * FACTORY-721 requirement 3's three scoping rules, one per shape of input:
 *   - `jira_search`: the caller's JQL is WRAPPED (`project = <own> AND
 *     (<jql>)`), never parsed/detected — a caller cannot smuggle a
 *     different project in by writing `OR project = OTHER`, since its own
 *     clause is always AND-ed inside the wrapper, not substituted for it.
 *     Two defects a review found in the first version of this wrapper are
 *     fixed in `scanJql`/`wrapJqlToProject` below: a trailing, top-level
 *     `ORDER BY …` is hoisted OUT of the parens (JQL requires it there,
 *     not inside them), and a `jql` whose own parens/quotes are
 *     unbalanced — which could otherwise let a clause break OUT of the
 *     wrapper's grouping — is refused rather than wrapped.
 *   - `jira_get_issue` / `jira_add_comment` / `jira_transition`: the `key`
 *     argument is validated against the same strict issue-key regex
 *     `set_doc`/`get_doc` already use (`JIRA_KEY_RE`, src/tools/docs.ts),
 *     then the issue is GET-FIRST so the project checked is the issue's
 *     CURRENT, real project (`fields.project.key`) — never the key's own
 *     prefix, which can read a different project if the issue was MOVED
 *     after it was filed (Jira keeps the old prefix on a moved issue's key).
 * FACTORY-721 requirement 4: no status is special-cased — a transition to
 * ANY status, Done included, is allowed once the scope check above passes;
 * this gate only ever decides "whose project is this", never "which
 * status".
 *
 * FACTORY-721 requirement 5: every call through this gate is logged — an
 * allowed call falls through to the real handler, which already logs its
 * own `[tools]`/outcome lines unchanged; every call THIS gate itself
 * decides (every refusal, and the JQL-wrap decision) logs its own line
 * here, in the same `  [tools] <agent> → ...` shape `forJiraCallers`
 * already uses, so a reader does not need a second log vocabulary for this
 * one caller tier.
 */
export function restrictJiraProjectManagers(
  tools: Record<string, ToolDef<any>>,
  ops: Pick<AtlassianOps, "getIssue">,
  log: (line: string) => void = console.error,
): Record<string, ToolDef<any>> {
  const gated: Record<string, ToolDef<any>> = {};
  for (const [name, def] of Object.entries(tools)) {
    gated[name] = {
      ...def,
      handler: (args: unknown, c: { headers: Readonly<Record<string, string>> }) => {
        const who = callerIdentity(c.headers);
        if (who?.provider !== "jira-project") return def.handler(args as never, c as never);

        // BUTCHR-397/BUTCHR-398: a query-level (singleton/persistent) jira-project
        // agent has no single project to scope to (see CallerIdentity's own doc
        // comment, src/mcp/identity.ts) — refused on EVERY tool, never passed
        // through unscoped, exactly like a non-allowlisted tool below.
        if ("query" in who) {
          log(`  [tools] ${who.agent} → refused ${name}: a query-level jira-project agent has no single project to scope this call to`);
          throw new Refusal(`${name}: refusing a query-level jira-project agent — it has no single project to scope this call to`);
        }

        const ownProject = who.resource;
        if (!JIRA_PROJECT_MANAGER_TOOLS.includes(name)) {
          log(`  [tools] ${who.agent} → refused ${name}: a jira-project (manager) agent may only call ${JIRA_PROJECT_MANAGER_TOOLS.join(", ")}`);
          throw new Refusal(
            `${name}: refusing a jira-project (manager) agent — only ${JIRA_PROJECT_MANAGER_TOOLS.join(", ")} are available, each scoped to its own project (${ownProject})`,
          );
        }

        if (name === "jira_search") {
          const { jql } = (args ?? {}) as { jql?: string };
          if (typeof jql !== "string") return def.handler(args as never, c as never); // malformed input — let the tool's own zod schema refuse it
          let wrapped: string;
          try {
            wrapped = wrapJqlToProject(jql, ownProject);
          } catch (err) {
            log(`  [tools] ${who.agent} → refused jira_search: ${(err as Error).message}`);
            throw err;
          }
          log(`  [tools] ${who.agent} → jira-project scope: wrapped jira_search JQL for project ${ownProject}`);
          return def.handler({ ...(args as object), jql: wrapped } as never, c as never);
        }

        // jira_get_issue / jira_add_comment / jira_transition: all take `key`.
        const { key } = (args ?? {}) as { key?: unknown };
        if (typeof key !== "string" || !JIRA_KEY_RE.test(key)) {
          log(`  [tools] ${who.agent} → refused ${name}: "${String(key)}" is not a valid Jira issue key`);
          throw new Refusal(`${name}: refusing a jira-project (manager) agent — "${String(key)}" is not a valid Jira issue key (expected ${JIRA_KEY_RE})`);
        }
        return Promise.resolve(ops.getIssue(key)).then((issue) => {
          const actual = currentProjectOf(issue);
          if (actual !== ownProject) {
            log(`  [tools] ${who.agent} → refused ${name} ${key}: belongs to project ${actual ?? "<unknown>"}, not its own project ${ownProject}`);
            throw new Refusal(
              `${name}: refusing a jira-project (manager) agent — ${key} belongs to project ${actual ?? "<unknown>"}, not its own project ${ownProject} (GET-first check: the issue's CURRENT project, not its key's prefix, so a moved issue cannot bypass this)`,
            );
          }
          return def.handler(args as never, c as never);
        });
      },
    };
  }
  return gated;
}
