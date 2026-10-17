/**
 * local/ui — the rule engine's `ResourceType` for `trello-card` rules: one
 * item per (rule, Trello card) match, keyed `trello-card:<rule>:<board#card>`,
 * active exactly while the rule's query returns the card. Built on upstream's
 * Trello client (FACTORY-1009, `../resources/trello-card.ts`), which reads
 * cards and comments on the one configured board; this module is the rule
 * type, staffing gate and change detection that client left out. Shaped like
 * `./zendesk-ticket-type.ts` on purpose, so the two read alike.
 *
 * A rule's query is the client's free-text match (a case-insensitive
 * substring of the card's name or description) plus two qualifiers the client
 * doesn't have: `list:<name>` (the card is in one of the named lists) and
 * `label:<name>` (the card has every named label). Names with spaces are
 * quoted: `list:"Ready for agent" label:bug login`. An empty query matches
 * every open card on the board.
 *
 * Notifications carry identity and a reason, never Trello-authored text: card
 * names, descriptions, list names and comments are written by whoever can
 * edit the board, so an agent re-reads them itself rather than having them
 * pushed into its prompt.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { loadTrelloAuth, scopedCardQuery, trelloCardQueryProblems, type TrelloAuthEnv, type TrelloCard, type TrelloComment, type TrelloCredentialFileIo, type TrelloList } from "../resources/trello-card.js";
import { parseTrelloCardRef, type TrelloCardRef } from "../resources/trello-card-ref.js";
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface TrelloCardMatch {
  agentKey: string;
  rule: Rule;
  card: TrelloCard;
}

export interface TrelloCardResourceDeps {
  /** Validated rules; only enabled `trello-card` rules are searched. */
  rules: readonly Rule[];
  /** Every open card on the board whose name or description contains this text (all of them for ""). */
  search: (text: string) => Promise<TrelloCard[]>;
  /** Every list on the board, read once per poll and only when some rule names a list. */
  lists: () => Promise<readonly TrelloList[]>;
  /** Comments on one card, oldest first — read when a card's activity moves with no field change, to tell a new comment from other activity. */
  comments: (ref: TrelloCardRef) => Promise<readonly TrelloComment[]>;
  /** True when a change to `resource` (now at `updated`) is `watcher`'s own write — its own comment — and not worth a nudge. */
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  log?: (line: string) => void;
  /** This provider's own running herd ids, for `logExecutionModeSwitches` (see `RuleResourceDeps.runningIds`, src/rules/resource-type.ts). */
  runningIds?: () => Promise<readonly string[]>;
}

/** True for exactly the herd ids this type owns. */
export const ownsTrelloCardAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "trello-card";

/**
 * The short id herdr labels and workspace directories use: `card-` and the
 * card id's last 8 hex digits. The full `<board>#<card>` stays the agent key;
 * a label is display-only and collision-checked separately
 * (`./display-label.ts`), like `zendeskTicketShortDisplayId` dropping the
 * subdomain.
 */
export function trelloCardShortDisplayId(resourceId: string): string {
  const ref = parseTrelloCardRef(resourceId);
  return ref ? `card-${ref.cardId.slice(-8)}` : resourceId;
}

export interface TrelloRuleQuery {
  /** Lowercased list names; a card must be in one of them. Empty means any list. */
  lists: string[];
  /** Lowercased label names; a card must have all of them. */
  labels: string[];
  /** What's left: the client's free-text match. */
  text: string;
}

/**
 * Splits a rule query into its `list:`/`label:` qualifiers and free text.
 * Problems are the free text's own (`trelloCardQueryProblems`: no
 * parentheses or boolean operators) plus an unclosed quote or an empty name.
 * Quotes around free-text words are dropped; the words are matched as one
 * phrase.
 */
export function parseTrelloRuleQuery(query: string): { ok: true; query: TrelloRuleQuery } | { ok: false; problems: string[] } {
  const lists: string[] = [];
  const labels: string[] = [];
  const words: string[] = [];
  const problems: string[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i]!)) { i++; continue; }
    const qualifier = /^(list|label):/i.exec(query.slice(i));
    if (qualifier) {
      const key = qualifier[1]!.toLowerCase() as "list" | "label";
      i += qualifier[0].length;
      let value: string;
      if (query[i] === '"') {
        const end = query.indexOf('"', i + 1);
        if (end === -1) {
          problems.push(`${key}: has an unclosed quote`);
          value = query.slice(i + 1);
          i = query.length;
        } else {
          value = query.slice(i + 1, end);
          i = end + 1;
        }
      } else {
        value = /^\S*/.exec(query.slice(i))![0];
        i += value.length;
      }
      value = value.trim().toLowerCase();
      if (!value) problems.push(`${key}: needs a name, e.g. ${key}:"Ready"`);
      else (key === "list" ? lists : labels).push(value);
      continue;
    }
    const word = /^\S+/.exec(query.slice(i))![0];
    i += word.length;
    const bare = word.replaceAll('"', "");
    if (bare) words.push(bare);
  }
  const text = words.join(" ");
  problems.push(...trelloCardQueryProblems(text));
  return problems.length ? { ok: false, problems } : { ok: true, query: { lists, labels, text: scopedCardQuery(text) } };
}

/** Why a `trello-card` rule query is unusable, or `[]`. Checked when rules load, so a bad rule stops the daemon before any search runs. */
export function trelloRuleQueryProblems(query: string): string[] {
  const parsed = parseTrelloRuleQuery(query);
  return parsed.ok ? [] : parsed.problems;
}

/** Whether a card the free-text search returned also passes the rule's `list:` and `label:` qualifiers. */
export function trelloCardPassesQualifiers(card: TrelloCard, listName: string | null, q: TrelloRuleQuery): boolean {
  if (q.lists.length && (listName === null || !q.lists.includes(listName.toLowerCase()))) return false;
  const has = new Set(card.labels.map((l) => l.toLowerCase()));
  return q.labels.every((l) => has.has(l));
}

/**
 * Every enabled `trello-card` rule's matches. Any failed search rejects the
 * whole poll. `warned` remembers which (rule, list) pairs have already been
 * logged as naming a list the board doesn't have, so that's said once.
 */
export async function searchTrelloCardRules(
  deps: Pick<TrelloCardResourceDeps, "rules" | "search" | "lists" | "log">,
  warned: Set<string> = new Set(),
): Promise<TrelloCardMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "trello-card");
  const parsed = enabled.map((rule) => {
    const q = parseTrelloRuleQuery(rule.query);
    if (!q.ok) throw new Error(`trello-card rule ${rule.id}: ${q.problems.join("; ")}`);
    return { rule, q: q.query };
  });
  const listNames = parsed.some((p) => p.q.lists.length)
    ? new Map((await deps.lists()).map((l) => [l.id, l.name]))
    : new Map<string, string>();
  const known = new Set([...listNames.values()].map((n) => n.toLowerCase()));
  const perRule = await Promise.all(parsed.map(async ({ rule, q }) => {
    for (const list of q.lists) {
      const key = `${rule.id}\0${list}`;
      if (!known.has(list) && !warned.has(key)) {
        warned.add(key);
        deps.log?.(`WARNING: [trello-card] rule ${rule.id} names a list the board doesn't have, so that part matches nothing`);
      }
    }
    const seen = new Set<string>();
    const out: TrelloCardMatch[] = [];
    for (const card of await deps.search(q.text)) {
      if (seen.has(card.ref)) continue;
      if (!trelloCardPassesQualifiers(card, card.listId ? listNames.get(card.listId) ?? null : null, q)) continue;
      seen.add(card.ref);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "trello-card", ruleId: rule.id, resourceId: card.ref }), rule, card });
    }
    return out;
  }));
  return perRule.flat();
}

export function specForTrelloCard({ agentKey, rule, card }: TrelloCardMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: card.ref,
    issuetype: "card",
    summary: card.name,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
    ...(rule.permissionMode ? { permissionMode: rule.permissionMode } : {}),
    ...(rule.lizardMode ? { lizardMode: true } : {}),
  };
}

/** The SpawnSpec for a `singleton`/`persistent` rule's one query-level agent: no single card (`resource` omitted), so no Trello tool can resolve it as one. */
export function specForTrelloCardQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every card "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
    ...(rule.permissionMode ? { permissionMode: rule.permissionMode } : {}),
    ...(rule.lizardMode ? { lizardMode: true } : {}),
  };
}

export const specForTrelloCardUnit = (u: ExecutionUnit<TrelloCardMatch>): SpawnSpec =>
  u.kind === "resource" ? specForTrelloCard(u.match) : specForTrelloCardQuery(u.rule, u.agentKey);

/** The card fields whose change is worth telling an agent about. Comments are detected through `updated` (below), so `decide()` can tell "a named field changed" from "only activity moved". */
const namedObserved = (c: TrelloCard) => JSON.stringify([c.name, c.desc, c.listId, c.labels, c.due]);
/** `diffMatches`' trigger: a named field or `updated` (Trello's last activity) moving. */
const triggerObserved = (m: TrelloCardMatch) => JSON.stringify([namedObserved(m.card), m.card.updated]);

/**
 * Reason precedence: a list move, then the name, then the description, then
 * any other observed field (no reason), then a new comment (its id). A list
 * move is reported as a `status` change between list ids (a card's list is
 * its status on a Trello board); the agent's nudge says only that it moved
 * (`trelloCardNudge`, src/agents/change-nudge.ts), never a list name.
 */
async function decideTrelloCard(from: TrelloCard, to: TrelloCard, deps: Pick<TrelloCardResourceDeps, "comments" | "suppress" | "log">, watcher: string): Promise<EventVerdict> {
  if (deps.suppress?.(to.ref, to.updated, watcher)) return { deliver: false };
  if (from.listId !== to.listId) return { deliver: true, reason: { status: { from: from.listId ?? "none", to: to.listId ?? "none" } } };
  if (from.name !== to.name) return { deliver: true, reason: { summary: true } };
  if (from.desc !== to.desc) return { deliver: true, reason: { description: true } };
  if (namedObserved(from) !== namedObserved(to)) return { deliver: true };
  return newCommentVerdict(from, to, deps);
}

async function newCommentVerdict(from: TrelloCard, to: TrelloCard, deps: Pick<TrelloCardResourceDeps, "comments" | "log">): Promise<EventVerdict> {
  const ref = parseTrelloCardRef(to.ref);
  if (!ref) return { deliver: false };
  let newest: TrelloComment | undefined;
  try {
    newest = (await deps.comments(ref)).at(-1);
  } catch (e) {
    deps.log?.(`WARNING: [trello-card] comments for ${to.ref} failed: ${(e as Error)?.message ?? e}`);
    return { deliver: true, reason: { undetermined: "check-failed" } satisfies NotifyReason };
  }
  const since = Date.parse(from.updated);
  const created = newest ? Date.parse(newest.created) : NaN;
  return newest && Number.isFinite(since) && Number.isFinite(created) && created > since
    ? { deliver: true, reason: { comment: newest.id } }
    : { deliver: false };
}

/**
 * Change detection over (prev, next) matches, per agent key. A card entering
 * or leaving a rule's query is not a notification: the reconciler spawns or
 * stops its agent (swarm), or the RELATED path reports it
 * (`singleton`/`persistent`). Same shape as `createZendeskTicketEventRules`.
 */
export function createTrelloCardEventRules(deps: Pick<TrelloCardResourceDeps, "comments" | "suppress" | "log">): EventRules<ExecutionUnit<TrelloCardMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<TrelloCardMatch>>, next: PollSnapshot<ExecutionUnit<TrelloCardMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), triggerObserved);
      const relatedOf = (related: readonly RelatedResource<ExecutionUnit<TrelloCardMatch>>[]) =>
        related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: TrelloCardMatch } => u.kind === "resource").map((u) => u.match);
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
            return decideTrelloCard(pair.from.card, pair.to.card, deps, key);
          }
          const pair = relatedDiff.pairFor(key);
          const entry = relatedEntry(key);
          if (!pair || !entry?.watchers.includes(watcher)) return { deliver: false };
          // The query agent watching this card: its own comment was recorded under its own key, not the card's.
          return decideTrelloCard(pair.from.card, pair.to.card, deps, watcher);
        },
      };
    },
  };
}

export function createTrelloCardResourceType(deps: TrelloCardResourceDeps): ResourceType<ExecutionUnit<TrelloCardMatch>> {
  let latest: TrelloCardMatch[] = [];
  const warned = new Set<string>();
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchTrelloCardRules(deps, warned);
        if (deps.runningIds) logExecutionModeSwitches("trello-card", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "trello-card");
        return groupExecutionUnits(enabled, latest);
      },
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createTrelloCardEventRules(deps),
    spawnConfig: { specFor: specForTrelloCardUnit },
  };
}

/**
 * The explicit opt-in Trello staffing needs, for the same reason as
 * `ZENDESK_RISK_ACK_ENV`: MCP tools don't confine a shell-capable agent
 * running as the daemon's OS user. It can read `TRELLO_API_KEY_FILE` and
 * `TRELLO_TOKEN_FILE` and call Trello directly with them, as the token's
 * account, on every board that account can reach. Trello stays off until the
 * operator sets this variable to exactly this value. Like Zendesk's, it's
 * read from butchr's environment only; settings.json can't set it.
 */
export const TRELLO_RISK_ACK_ENV = "BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK";
export const TRELLO_RISK_ACK_VALUE = "agents-can-read-the-trello-credentials";

/**
 * Whether this daemon may run `trello-card` rules, decided once at startup.
 * Fails closed: without the acknowledgement, without `TRELLO_BOARD_ID` and
 * usable key and token files, or with any enabled rule whose query can't be
 * used, NO trello-card rule runs and nothing is spawned for one; the reason
 * says why. Other providers are unaffected. The credential files are read
 * only when an enabled rule needs them and the acknowledgement is set.
 */
export type TrelloCardStaffing =
  | { run: true; rules: Rule[]; boardId: string; apiKey: string; token: string }
  | { run: false; rules: Rule[]; reason: string | null };

/** FACTORY-66's switch, checked first: when it's off, nothing is read (`zendeskTicketStaffingIfEnabled`'s twin). */
export function trelloCardStaffingIfEnabled(rules: readonly Rule[], env: TrelloAuthEnv, enabled: boolean, io?: TrelloCredentialFileIo): TrelloCardStaffing {
  if (!enabled) return { run: false, rules: rules.filter((r) => r.enabled && r.resourceProvider === "trello-card"), reason: null };
  return trelloCardStaffing(rules, env, io);
}

export function trelloCardStaffing(rules: readonly Rule[], env: TrelloAuthEnv, io?: TrelloCredentialFileIo): TrelloCardStaffing {
  const enabled = rules.filter((r) => r.enabled && r.resourceProvider === "trello-card");
  if (!enabled.length) return { run: false, rules: [], reason: null };
  const ids = enabled.map((r) => r.id).join(", ");
  if (env[TRELLO_RISK_ACK_ENV]?.trim() !== TRELLO_RISK_ACK_VALUE) {
    return { run: false, rules: enabled, reason: `trello-card rules not staffed (${ids}): Trello is off until ${TRELLO_RISK_ACK_ENV}=${TRELLO_RISK_ACK_VALUE} is set. Agents run shell commands as the daemon's user, so they can read the Trello API key and token and call Trello directly, on every board the token can reach; the tools are not a boundary (see docs/trello-card.md)` };
  }
  const problems = enabled.flatMap((r) => trelloRuleQueryProblems(r.query).map((p) => `${r.id}: ${p}`));
  if (problems.length) return { run: false, rules: enabled, reason: `trello-card rules not staffed (${ids}): ${problems.join("; ")}` };
  const auth = loadTrelloAuth(env, io);
  if (!auth.ok) return { run: false, rules: enabled, reason: `trello-card rules not staffed (${ids}): ${auth.reason}` };
  return { run: true, rules: enabled, boardId: auth.boardId, apiKey: auth.apiKey, token: auth.token };
}
