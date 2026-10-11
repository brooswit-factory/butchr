/**
 * FACTORY-998 (story FACTORY-992, epic FACTORY-348): the `confluence-page`
 * resource provider's query — WHAT ancestor page's children to enumerate,
 * kept apart from HOW that enumeration actually talks to Atlassian
 * (src/rules/confluence-page-type.ts), the same split
 * src/resources/filesystem-query.ts documents for `filesystem`: validated at
 * rule-load time (parseRules, src/rules/rules.ts) without ever touching the
 * network, exactly as `filesystemQueryProblems`/`zendeskTicketQueryProblems`
 * already do for their own providers.
 *
 * SYNTAX DECISION, same reasoning `filesystem-query.ts`'s own header
 * records: every OTHER provider's `Rule.query` is a plain string (JQL,
 * GitHub/Zendesk search syntax), so widening `Rule.query`'s own type for
 * one provider is out of scope. Unlike `filesystem`, this query needs only
 * ONE field, but it is still a small JSON object rather than a bare string
 * — consistent with how a structured provider's query reads in this
 * schema (`{"ancestor": "<page id>"}`), and it leaves room to add fields
 * later (e.g. a recursion depth) without another syntax decision.
 *
 * SHAPE: `{"ancestor": "<page id>"}` — `ancestor` is a BARE NUMERIC
 * Confluence page id, the SAME canonical form `ConfluencePageRef` already
 * defines (`./confluence-page-ref.ts`) for a `confluence-page` resource's
 * own id. Deliberately NOT accepting a Confluence page URL here, even
 * though `parseConfluencePageRef` would: a rule's query is written once at
 * rule-authoring time and should read as the same identity a resource id
 * under it will take, not a second spelling of one page translated at
 * parse time.
 */
import { isConfluencePageRef } from "./confluence-page-ref.js";

/** The `confluence-page` provider's parsed query: the ancestor page whose DIRECT children this rule watches. */
export interface ConfluencePageQuery {
  readonly ancestor: string;
}

const QUERY_FIELDS = new Set(["ancestor"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why a `confluence-page` rule query is unusable, or `[]`. Checked at
 * rule-load time (parseRules) — never touches Atlassian itself: whether
 * `ancestor` actually exists, or is itself readable, is a DISCOVERY-time
 * fact (src/rules/confluence-page-type.ts), not a load-time one, the same
 * "a bad read is not a valid empty result" discipline
 * `filesystemQueryProblems`/`zendeskTicketQueryProblems` already apply to
 * their own queries.
 */
export function confluencePageQueryProblems(query: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(query);
  } catch (e) {
    return [`query is not valid JSON: ${(e as Error).message}`];
  }
  if (!isObject(doc)) return ["query must be a JSON object"];
  const problems: string[] = [];
  for (const k of Object.keys(doc)) if (!QUERY_FIELDS.has(k)) problems.push(`query has unknown field "${k}"`);
  const ancestor = doc.ancestor;
  if (typeof ancestor !== "string" || !ancestor.trim()) {
    problems.push(`query.ancestor must be a non-empty string`);
  } else if (!isConfluencePageRef(ancestor.trim())) {
    problems.push(`query.ancestor "${ancestor}" must be a bare numeric Confluence page id (no URL, no {space,pageId} pair)`);
  }
  return problems;
}

/**
 * The query actually used, resolved from the rule's JSON string. Throws for
 * anything `confluencePageQueryProblems` would flag — callers only ever
 * call this after that check has already passed at rule-load time, same
 * discipline as `parseFilesystemQuery`/`scopedTicketQuery`.
 */
export function parseConfluencePageQuery(query: string): ConfluencePageQuery {
  const problems = confluencePageQueryProblems(query);
  if (problems.length) throw new Error(`confluence-page query rejected: ${problems.join("; ")}`);
  const doc = JSON.parse(query) as Record<string, unknown>;
  return { ancestor: (doc.ancestor as string).trim() };
}
