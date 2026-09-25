/**
 * The rule engine's `ResourceType` for `zendesk-ticket` rules: one item per
 * (rule, Zendesk ticket) match, keyed `zendesk-ticket:<rule>:<subdomain#id>`,
 * active exactly while the rule's query returns the ticket.
 *
 * Kept apart from the other providers on purpose: it shares the generic loop,
 * agent keys and rule schema, and nothing else. A `zendesk-ticket` rule has no
 * relationships.
 *
 * Notifications carry identity and a reason, never Zendesk-authored text:
 * subjects and comments are written by customers, so an agent re-reads them
 * itself rather than having them pushed into its prompt.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { loadZendeskAuth, scopedTicketQuery, type ZendeskAuthEnv, type ZendeskComment, type ZendeskTicket, type ZendeskTokenFileIo } from "../resources/zendesk-ticket.js";
import { parseZendeskTicketRef, type ZendeskTicketRef } from "../resources/zendesk-ticket-ref.js";
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import type { Rule } from "./rules.js";

export interface ZendeskTicketMatch {
  agentKey: string;
  rule: Rule;
  ticket: ZendeskTicket;
}

export interface ZendeskTicketResourceDeps {
  /** Validated rules; only enabled `zendesk-ticket` rules are searched. */
  rules: readonly Rule[];
  /** Every ticket one rule query matches. */
  search: (query: string) => Promise<ZendeskTicket[]>;
  /** Comments on one ticket, oldest first — read when a ticket's `updated` moves with no field change, to tell a new comment from other activity. */
  comments: (ref: ZendeskTicketRef) => Promise<readonly ZendeskComment[]>;
  /** True when a change to `resource` (now at `updated`) is `watcher`'s own write — its own note — and not worth a nudge. */
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  log?: (line: string) => void;
}

/** True for exactly the herd ids this type owns. */
export const ownsZendeskTicketAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "zendesk-ticket";

/** Every enabled `zendesk-ticket` rule's matches. Any failed search rejects the whole poll. */
export async function searchZendeskTicketRules(deps: Pick<ZendeskTicketResourceDeps, "rules" | "search">): Promise<ZendeskTicketMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "zendesk-ticket");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const seen = new Set<string>();
    const out: ZendeskTicketMatch[] = [];
    for (const ticket of await deps.search(rule.query)) {
      if (seen.has(ticket.ref)) continue;
      seen.add(ticket.ref);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: rule.id, resourceId: ticket.ref }), rule, ticket });
    }
    return out;
  }));
  return perRule.flat();
}

export function specForZendeskTicket({ agentKey, rule, ticket }: ZendeskTicketMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: ticket.ref,
    issuetype: ticket.ticketType?.toLowerCase() ?? "ticket",
    summary: ticket.subject,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/** The ticket fields whose change is worth telling an agent about. Comments are detected through `updated` (below). */
const observed = (t: ZendeskTicket) => JSON.stringify([t.subject, t.status, t.priority, t.ticketType, t.tags]);

/**
 * Change detection over (prev, next) matches, per agent key. A ticket
 * entering or leaving a rule's query is not a notification — the reconciler
 * spawns or stops its agent.
 *
 * Zendesk's ticket carries no comment count, so a move in `updated` with no
 * observed field change reads the ticket's comments: a comment created after
 * the previous `updated` is a new comment; anything else (SLA or metric
 * updates, a custom field) notifies nobody.
 *
 * Reason precedence: status, then subject, then any other observed field
 * (no reason), then a new comment (its id).
 */
export function createZendeskTicketEventRules(deps: Pick<ZendeskTicketResourceDeps, "comments" | "suppress" | "log">): EventRules<ZendeskTicketMatch> {
  return {
    async poll(prev: PollSnapshot<ZendeskTicketMatch>, next: PollSnapshot<ZendeskTicketMatch>): Promise<EventPoll> {
      const before = new Map(prev.primary.map((m) => [m.agentKey, m.ticket]));
      const pairs = new Map<string, { from: ZendeskTicket; to: ZendeskTicket }>();
      for (const m of next.primary) {
        const from = before.get(m.agentKey);
        if (from && (observed(from) !== observed(m.ticket) || from.updated !== m.ticket.updated)) pairs.set(m.agentKey, { from, to: m.ticket });
      }
      return {
        changedPrimary: [...pairs.keys()],
        changedRelated: [],
        async decide(key, watcher, space): Promise<EventVerdict> {
          const pair = pairs.get(key);
          if (space !== "primary" || watcher !== key || !pair) return { deliver: false };
          const { from, to } = pair;
          if (deps.suppress?.(to.ref, to.updated, key)) return { deliver: false };
          if (from.status !== to.status) return { deliver: true, reason: { status: { from: from.status, to: to.status } } };
          if (from.subject !== to.subject) return { deliver: true, reason: { summary: true } };
          if (observed(from) !== observed(to)) return { deliver: true };
          return newCommentVerdict(from, to);
        },
      };
      async function newCommentVerdict(from: ZendeskTicket, to: ZendeskTicket): Promise<EventVerdict> {
        const ref = parseZendeskTicketRef(to.ref);
        if (!ref) return { deliver: false };
        let newest: ZendeskComment | undefined;
        try {
          newest = (await deps.comments(ref)).at(-1);
        } catch (e) {
          deps.log?.(`WARNING: [zendesk-ticket] comments for ${to.ref} failed: ${(e as Error)?.message ?? e}`);
          return { deliver: true, reason: { undetermined: "check-failed" } satisfies NotifyReason };
        }
        const since = Date.parse(from.updated);
        const created = newest ? Date.parse(newest.created) : NaN;
        return newest && Number.isFinite(since) && Number.isFinite(created) && created > since
          ? { deliver: true, reason: { comment: newest.id } }
          : { deliver: false };
      }
    },
  };
}

export function createZendeskTicketResourceType(deps: ZendeskTicketResourceDeps): ResourceType<ZendeskTicketMatch> {
  return {
    discovery: { idOf: (m) => m.agentKey, search: () => searchZendeskTicketRules(deps) },
    activation: { verdictFor: () => "active" },
    eventRules: createZendeskTicketEventRules(deps),
    spawnConfig: { specFor: specForZendeskTicket },
  };
}

/**
 * The explicit opt-in Zendesk staffing needs. MCP tools do not confine a
 * shell-capable agent running as the daemon's OS user: it can read
 * `ZENDESK_OAUTH_TOKEN_FILE` (or the daemon's environment) and call the
 * Zendesk API directly, public replies included. Zendesk stays dormant until
 * the operator sets this variable to exactly this value, acknowledging that.
 */
export const ZENDESK_RISK_ACK_ENV = "BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK";
export const ZENDESK_RISK_ACK_VALUE = "agents-can-read-the-zendesk-token";

/**
 * Whether this daemon may run `zendesk-ticket` rules, decided once at startup.
 * Fails closed: without the `ZENDESK_RISK_ACK_ENV` acknowledgement, without
 * `ZENDESK_SUBDOMAIN` and a usable
 * `ZENDESK_OAUTH_TOKEN_FILE`, or with any enabled rule whose query cannot be
 * sent, NO zendesk-ticket rule runs and nothing is spawned for one — the
 * reason says why. Other providers are unaffected. The token file is read
 * only when an enabled rule needs it and the acknowledgement is set.
 */
export type ZendeskTicketStaffing =
  | { run: true; rules: Rule[]; subdomain: string; token: string }
  | { run: false; rules: Rule[]; reason: string | null };

export function zendeskTicketStaffing(rules: readonly Rule[], env: ZendeskAuthEnv, io?: ZendeskTokenFileIo): ZendeskTicketStaffing {
  const enabled = rules.filter((r) => r.enabled && r.resourceProvider === "zendesk-ticket");
  if (!enabled.length) return { run: false, rules: [], reason: null };
  const ids = enabled.map((r) => r.id).join(", ");
  if (env[ZENDESK_RISK_ACK_ENV]?.trim() !== ZENDESK_RISK_ACK_VALUE) {
    return { run: false, rules: enabled, reason: `zendesk-ticket rules not staffed (${ids}): Zendesk is off until ${ZENDESK_RISK_ACK_ENV}=${ZENDESK_RISK_ACK_VALUE} is set. Agents run shell commands as the daemon's user, so they can read the OAuth token and call Zendesk directly, including public replies; the internal-note-only tool is not a boundary (see docs/zendesk-ticket.md)` };
  }
  const problems: string[] = [];
  for (const r of enabled) {
    try { scopedTicketQuery(r.query); } catch (e) { problems.push(`${r.id}: ${(e as Error).message}`); }
  }
  if (problems.length) return { run: false, rules: enabled, reason: `zendesk-ticket rules not staffed (${ids}): ${problems.join("; ")}` };
  const auth = loadZendeskAuth(env, io);
  if (!auth.ok) return { run: false, rules: enabled, reason: `zendesk-ticket rules not staffed (${ids}): ${auth.reason}` };
  return { run: true, rules: enabled, subdomain: auth.subdomain, token: auth.token };
}
