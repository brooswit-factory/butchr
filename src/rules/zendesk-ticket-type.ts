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
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
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
  /** BUTCHR-398: this provider's own running herd ids, for `logExecutionModeSwitches` — see `RuleResourceDeps.runningIds`'s own doc comment (src/rules/resource-type.ts). Optional; omitted, no mode-switch logging runs. */
  runningIds?: () => Promise<readonly string[]>;
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

/**
 * BUTCHR-398: the SpawnSpec for a `singleton`/`persistent` rule's ONE
 * query-level agent — no single ticket (`resource` omitted), so no Zendesk
 * tool can be misled into resolving it as a ticket ref.
 */
export function specForZendeskTicketQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every ticket "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

export const specForZendeskTicketUnit = (u: ExecutionUnit<ZendeskTicketMatch>): SpawnSpec =>
  u.kind === "resource" ? specForZendeskTicket(u.match) : specForZendeskTicketQuery(u.rule, u.agentKey);

/** The ticket fields whose change is worth telling an agent about, named. Comments are detected through `updated` (below) — deliberately excluded here so `decide()` can tell "a named field changed" apart from "only `updated` moved" (see `triggerObserved`). */
const namedObserved = (t: ZendeskTicket) => JSON.stringify([t.subject, t.status, t.priority, t.ticketType, t.tags]);
/** `diffMatches`' own trigger: a named field OR `updated` moving — the exact OR `namedObserved(from) !== namedObserved(to) || from.updated !== to.updated` had before this ticket, folded into one equality check by including `updated` in the tuple. */
const triggerObserved = (m: ZendeskTicketMatch) => JSON.stringify([namedObserved(m.ticket), m.ticket.updated]);

async function decideZendeskTicket(from: ZendeskTicket, to: ZendeskTicket, deps: Pick<ZendeskTicketResourceDeps, "comments" | "suppress" | "log">, watcher: string): Promise<EventVerdict> {
  if (deps.suppress?.(to.ref, to.updated, watcher)) return { deliver: false };
  if (from.status !== to.status) return { deliver: true, reason: { status: { from: from.status, to: to.status } } };
  if (from.subject !== to.subject) return { deliver: true, reason: { summary: true } };
  if (namedObserved(from) !== namedObserved(to)) return { deliver: true };
  return newCommentVerdict(from, to, deps);
}

async function newCommentVerdict(from: ZendeskTicket, to: ZendeskTicket, deps: Pick<ZendeskTicketResourceDeps, "comments" | "log">): Promise<EventVerdict> {
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

/**
 * Change detection over (prev, next) matches, per agent key. A ticket
 * entering or leaving a rule's query is not a notification — the reconciler
 * spawns or stops its agent (swarm), or reports appear/disappear via the
 * RELATED path below (`singleton`/`persistent`, BUTCHR-398).
 *
 * Zendesk's ticket carries no comment count, so a move in `updated` with no
 * observed field change reads the ticket's comments: a comment created after
 * the previous `updated` is a new comment; anything else (SLA or metric
 * updates, a custom field) notifies nobody.
 *
 * Reason precedence: status, then subject, then any other observed field
 * (no reason), then a new comment (its id).
 *
 * BUTCHR-398: PRIMARY covers only `"resource"`-kind units (swarm, unchanged
 * from before this ticket). RELATED covers every `singleton`/`persistent`
 * rule's own currently-matched tickets, watcher = that rule's query agent
 * key — the SAME diff logic, run over a different input list.
 */
export function createZendeskTicketEventRules(deps: Pick<ZendeskTicketResourceDeps, "comments" | "suppress" | "log">): EventRules<ExecutionUnit<ZendeskTicketMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<ZendeskTicketMatch>>, next: PollSnapshot<ExecutionUnit<ZendeskTicketMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), triggerObserved);
      const relatedOf = (related: readonly RelatedResource<ExecutionUnit<ZendeskTicketMatch>>[]) =>
        related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: ZendeskTicketMatch } => u.kind === "resource").map((u) => u.match);
      const relatedDiff = diffMatches(relatedOf(prev.related), relatedOf(next.related), triggerObserved);
      const relatedEntry = (key: string) =>
        next.related.find((r) => unitAgentKey(r.issue) === key) ?? prev.related.find((r) => unitAgentKey(r.issue) === key);
      return {
        changedPrimary: primaryDiff.changed,
        changedRelated: relatedDiff.changed,
        async decide(key, watcher, space): Promise<EventVerdict> {
          if (space === "primary") {
            const pair = primaryDiff.pairFor(key);
            if (watcher !== key || !pair) return { deliver: false };
            return decideZendeskTicket(pair.from.ticket, pair.to.ticket, deps, key);
          }
          const pair = relatedDiff.pairFor(key);
          const entry = relatedEntry(key);
          if (!pair || !entry?.watchers.includes(watcher)) return { deliver: false };
          return decideZendeskTicket(pair.from.ticket, pair.to.ticket, deps, key);
        },
      };
    },
  };
}

export function createZendeskTicketResourceType(deps: ZendeskTicketResourceDeps): ResourceType<ExecutionUnit<ZendeskTicketMatch>> {
  let latest: ZendeskTicketMatch[] = [];
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchZendeskTicketRules(deps);
        if (deps.runningIds) logExecutionModeSwitches("zendesk-ticket", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "zendesk-ticket");
        return groupExecutionUnits(enabled, latest);
      },
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createZendeskTicketEventRules(deps),
    spawnConfig: { specFor: specForZendeskTicketUnit },
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
