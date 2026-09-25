/**
 * The rule engine's `ResourceType` (src/resources/types.ts): what the generic
 * loop (src/daemon/loop.ts `runResourceLoop`) staffs once rules replace the
 * issue-type and project tiers.
 *
 * One resource item is one (rule, Jira issue) MATCH, identified by its agent
 * key — so a ticket matched by two rules is two items, two agents, two
 * workspaces. An agent exists exactly while its rule's query returns its
 * ticket: every match is `"active"`, a ticket leaving the query is simply
 * absent next poll, and the reconciler stops its agent. Zero enabled rules
 * means zero searches and an empty desired set.
 *
 * Relationships are READ, never written: a rule's `childRule` and
 * `inwardConnectionRules` name the rules whose agents it hears, and an
 * existing Jira `Implements` (child) or `Relates` (inward) link names which
 * tickets (see `relatedForRules`). Deliberately NOT here (later slices): creating or
 * editing links, relationship patterns, and stand-down sleep.
 */
import type { JiraIssue } from "../atlassian/types.js";
import type { SpawnSpec } from "../agents/workspace.js";
import { bossKeyFrom, createIssueEventRules, type IssueResourceDeps } from "../resources/issue.js";
import { jiraIssueClass } from "../resources/jira-idea.js";
import { capLinkedItems, discoverLinkedItems } from "../resources/linked-discovery.js";
import type { EventPoll, EventRules, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { createLinkedDiscoveryTracker, formatLinkedDiscoveryLines } from "../jira-watch/linked-discovery-log.js";
import { decodeAgentKey, decodeAnyAgentKey, encodeAgentKey, encodeQueryAgentKey } from "./agent-key.js";
import { groupExecutionUnits, logExecutionModeSwitches, mergeRelated, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface RuleMatch {
  agentKey: string;
  rule: Rule;
  issue: JiraIssue;
}

export interface RuleResourceDeps {
  /** Validated rules, loaded once at startup. Disabled rules are never searched. */
  rules: readonly Rule[];
  /** Raw Jira search for one rule's JQL. */
  search: (jql: string) => Promise<JiraIssue[]>;
  /** Own-write echo check, keyed by the AGENT being notified (see `createRuleEventRules`). */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  comments?: IssueResourceDeps["comments"];
  log?: (line: string) => void;
  /**
   * BUTCHR-398: this provider's own currently-running herd ids (already
   * scoped — a caller passes `herd.runningIssues()` filtered by
   * `ownsRuleAgent`), consulted once per poll purely to log a loud
   * WARNING when a running agent's shape disagrees with its rule's CURRENT
   * `execution` mode (`logExecutionModeSwitches`, src/rules/execution.ts) —
   * never consulted for reconciliation itself (that stays the ordinary
   * desired-vs-running diff in src/reconcile/plan.ts). Optional; omitted,
   * no mode-switch logging runs (every existing caller/test).
   */
  runningIds?: () => Promise<readonly string[]>;
}

/**
 * True for exactly the `jira-work` herd ids this engine owns — never a
 * legacy bare-issue or project id, nor another provider's agent. Recognises
 * both a per-resource key and a query-level one (BUTCHR-397: `singleton`/
 * `persistent` rules run a single agent per rule, not per matched ticket) so
 * neither shape is ever mistaken for legacy/unowned once BUTCHR-398 starts
 * spawning them.
 */
export const ownsRuleAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "jira-work";

/** Told about each issue a rule's query returned that its provider may not staff (see src/resources/jira-idea.ts). */
export type ExcludedIssue = (rule: Rule, issue: JiraIssue) => void;

/**
 * Every enabled rule's matches. Rules are searched in parallel; ANY failure
 * rejects the whole poll, never a partial result — a partial result would
 * read as "those tickets left the query" and stop healthy agents.
 *
 * Only proven work items match: a Product Discovery idea, or anything that
 * might be one, is `jira-idea`'s or nobody's, however broad the JQL.
 */
export async function searchRules(deps: Pick<RuleResourceDeps, "rules" | "search"> & { excluded?: ExcludedIssue }): Promise<RuleMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "jira-work");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const issues = await deps.search(rule.query);
    const seen = new Set<string>();
    const out: RuleMatch[] = [];
    for (const issue of issues) {
      if (jiraIssueClass(issue) !== "work") { deps.excluded?.(rule, issue); continue; }
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: rule.resourceProvider, ruleId: rule.id, resourceId: issue.key }), rule, issue });
    }
    return out;
  }));
  return perRule.flat();
}

/**
 * The related set: which rule agents hear which OTHER matched tickets.
 *
 * Agent `R:B` hears ticket `W` when either holds:
 * - up (boss hears worker): Jira has `W` implementing `B` — an `Implements`
 *   link with `W` on the implementer side. **Routed on the LINK alone**: no
 *   rule configuration is consulted, and `W` need not be matched by any of
 *   THIS daemon's rules (see `foreign`, and `foreignImplementerKeys`).
 * - inward (sideways): for some rule `C` matching `W`, `C` is in `R`'s
 *   `inwardConnectionRules` and Jira has `W` and `B` joined by a `Relates`
 *   link, either way round.
 * Links are read from either ticket's `issuelinks`.
 *
 * BUTCHR-388 — A GUARANTEE WAS DELIBERATELY WITHDRAWN HERE, READ BEFORE
 * RESTORING IT: `Implements` used to require the listener's rule to name the
 * source's rule as its `relationships.childRule`. That gate was doing two
 * jobs and only one was ever costed:
 *   1. whether a boss hears its implementer at all — **dead in production**:
 *      no rules file in this fleet declares `childRule`, so NOTHING was ever
 *      heard, and the parent/child handoff silently depended on a human
 *      noticing (198 of 198 notify lines in 24h were self-addressed);
 *   2. WHICH rule hears, when one ticket is matched by several rules —
 *      **given up on purpose.** Every rule matching the boss ticket now
 *      hears. Verified 2026-09-20 against both live rules files: booswrit's
 *      three rules are `issuetype = Epic|Task|Bug` and wroosbit's two enabled
 *      ones are `Story|Sub-task`, so no ticket matches two rules on either
 *      daemon and job 2 has never fired here.
 * The gate also cannot be satisfied across daemons by construction: a rule id
 * is per-file, and a ticket matched only by the other daemon has no local rule
 * to name — which is every parent/child pair in a fleet that splits
 * Epic/Task/Bug from Story/Sub-task by account. `src/jira-watch/routes.ts` has
 * always stated the intended rule with no gate at all ("a boss hears what
 * implements it"), and the legacy `createRelated` (src/resources/issue.ts)
 * honoured it "regardless of assignee". This restores that.
 *
 * `Implements` carries direction itself: a worker never hears its boss, and
 * nothing routes down. `Relates` is symmetric in Jira, so ONLY configuration
 * decides direction across it: `R:B` hearing `C:W` says nothing about `C:W`
 * hearing `R:B`, which needs `R` in `C`'s `inwardConnectionRules`. The two
 * link kinds never stand in for each other (a child over `Relates`, or an
 * inward connection over `Implements`, routes nothing), and `Blocks` and
 * other types route nothing. A ticket no enabled rule matches has no
 * identity here and neither hears nor is heard. Only agents in `active`
 * watch.
 *
 * BUTCHR-406 fix: "the agent in `active`" is not always `listener.agentKey`.
 * `matches` (and so `byIssue`) always carries the bare PER-RESOURCE agent key
 * (`encodeAgentKey`, from `searchRules`) regardless of the rule's `execution`
 * — but for a `singleton`/`persistent` rule, the thing actually running (and
 * so the id `active` actually contains, per `groupExecutionUnits`/
 * `unitAgentKey`) is the QUERY-level key (`encodeQueryAgentKey`) for the
 * whole rule, never a per-resource key. Before this fix, a singleton/
 * persistent listener's bare key was NEVER in `active`, so `implementsEdge`/
 * `relatesEdge` silently dropped every edge addressed to it — the boss was
 * never notified (see the BUTCHR-406 regression test, red on unmodified
 * main for exactly this). `liveAgentKeyFor` below names the key that is
 * ACTUALLY running for a given match's rule; a listener is active when
 * EITHER form is present (byte-identical to before for `swarm`, where the
 * two forms coincide), and it is the LIVE key — not the bare one — that gets
 * recorded as the watcher, so `notify` addresses the agent that actually
 * exists rather than a phantom per-resource id nothing will ever spawn.
 *
 * One entry per heard TICKET, however many rules or links connect it, so a
 * listener hears one change once. Its id is the smallest contributing agent
 * key — any stable member works, since routing reads the ticket, not the rule.
 * BUTCHR-390: that tiebreak is arbitrary and only becomes visible the day a
 * fleet runs overlapping rules; it is tracked there, not settled here.
 */
export function relatedForRules(
  rules: readonly Rule[],
  matches: readonly RuleMatch[],
  active: readonly string[],
  foreign: readonly JiraIssue[] = [],
): RelatedResource<RuleMatch>[] {
  const activeSet = new Set(active);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const hearsInward = (listener: Rule, source: Rule) =>
    byId.get(listener.id)?.relationships?.inwardConnectionRules?.includes(source.id) ?? false;
  // BUTCHR-406: the key the listener's rule ACTUALLY runs under — its own
  // per-resource key for `swarm` (identical to `m.agentKey`, so this changes
  // nothing for the pre-existing, all-swarm behaviour), or its rule's single
  // query-level key for `singleton`/`persistent`.
  const liveAgentKeyFor = (m: RuleMatch): string =>
    m.rule.execution === "swarm" ? m.agentKey : encodeQueryAgentKey({ resourceProvider: m.rule.resourceProvider, ruleId: m.rule.id });
  const byIssue = new Map<string, RuleMatch[]>();
  for (const m of matches) byIssue.set(m.issue.key, [...(byIssue.get(m.issue.key) ?? []), m]);
  const foreignByKey = new Map(foreign.map((i) => [i.key, i]));

  /**
   * BUTCHR-388: the sources a listener can hear for `sourceKey` — this
   * daemon's own matches when it has them, otherwise a stand-in for a ticket
   * only ANOTHER daemon's rules match. `foreignMatch`'s `rule` is a sentinel
   * (`external`, disabled, empty query/brief): a related entry is only ever
   * diffed and addressed — the loop reads `agentKey` (via `discovery.idOf`)
   * and `issue`, never `rule`, and never spawns one — so there is no caller
   * to mislead. Its `agentKey` is deliberately NOT an `encodeAgentKey` value,
   * so it can never collide with a primary agent key or be decoded as one.
   */
  const sourcesFor = (sourceKey: string, listener: RuleMatch): RuleMatch[] => {
    const own = byIssue.get(sourceKey);
    if (own?.length) return own;
    const issue = foreignByKey.get(sourceKey);
    if (!issue) return [];
    const provider = listener.rule.resourceProvider;
    return [{
      agentKey: `related:${provider}:${issue.key}`,
      rule: { id: FOREIGN_RULE_ID, enabled: false, resourceProvider: provider, query: "", brief: "", execution: "swarm", account: "none", role: "worker" },
      issue,
    }];
  };
  const out = new Map<string, { issue: RuleMatch; watchers: Set<string> }>();
  // BUTCHR-406: takes the WATCHER'S KEY directly (already resolved to the
  // live agent key by the caller), not a `RuleMatch` — `record` no longer
  // decides which key names the listener, `implementsEdge`/`relatesEdge` do.
  const record = (sourceKey: string, watcherKey: string, source: RuleMatch) => {
    const e = out.get(sourceKey);
    if (!e) out.set(sourceKey, { issue: source, watchers: new Set([watcherKey]) });
    else {
      e.watchers.add(watcherKey);
      if (source.agentKey < e.issue.agentKey) e.issue = source;
    }
  };
  /**
   * BUTCHR-388: an `Implements` edge routes on the LINK alone — "a boss hears
   * what implements it", the rule `src/jira-watch/routes.ts` has always
   * stated and the legacy `createRelated` (src/resources/issue.ts) has always
   * honoured: *"a boss must hear about its implementer's progress even when
   * another account staffs it."* The rules engine added a `relationships.childRule`
   * gate on top of that, which no rules file in this fleet declares and which
   * cannot be satisfied across daemons anyway (a rule id is per-file, and a
   * ticket matched only by the other daemon has no local rule to name). The
   * listener is the BOSS in both branches below — this does NOT route an
   * implementer to its boss, the case `routes.ts` excludes deliberately.
   */
  const implementsEdge = (sourceKey: string, listenerKey: string) => {
    if (sourceKey === listenerKey) return;
    for (const listener of byIssue.get(listenerKey) ?? []) {
      const live = liveAgentKeyFor(listener);
      if (!activeSet.has(listener.agentKey) && !activeSet.has(live)) continue;
      for (const source of sourcesFor(sourceKey, listener)) record(sourceKey, live, source);
    }
  };
  /** `Relates` is symmetric in Jira, so ONLY configuration decides direction across it — unchanged (BUTCHR-406: same live-key fix as `implementsEdge` above). */
  const relatesEdge = (sourceKey: string, listenerKey: string) => {
    if (sourceKey === listenerKey) return;
    for (const listener of byIssue.get(listenerKey) ?? []) {
      const live = liveAgentKeyFor(listener);
      if (!activeSet.has(listener.agentKey) && !activeSet.has(live)) continue;
      for (const source of byIssue.get(sourceKey) ?? []) {
        if (!hearsInward(listener.rule, source.rule)) continue;
        record(sourceKey, live, source);
      }
    }
  };
  for (const [key, ms] of byIssue) {
    for (const link of ms[0]!.issue.issuelinks ?? []) {
      if (link.type === "Implements") {
        if (link.otherEnd === "inward") implementsEdge(key, link.key);
        else implementsEdge(link.key, key);
      } else if (link.type === "Relates") {
        relatesEdge(key, link.key);
        relatesEdge(link.key, key);
      }
    }
  }
  return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers].sort() }));
}

/** BUTCHR-388: the sentinel rule id carried by a related entry for a ticket only another daemon's rules match. Never a real rule, never spawned, never decoded. */
export const FOREIGN_RULE_ID = "external";

/**
 * BUTCHR-388: most keys a single `key in (...)` fetch will ask for per poll.
 *
 * ⚠️ This bounds the JQL by STARVING the tail, not by deferring it.
 * `foreignImplementerKeys` sorts, and this takes the first N of that stable
 * order every poll — so with a steady overflow the keys past N are **never**
 * heard, not "heard on a later poll". They become reachable only when a key
 * ahead of them leaves the set. That is the same silently-wrong shape this
 * ticket exists to fix, one layer up, which is why crossing the limit is
 * logged (see `related`) rather than left to be inferred from a fleet that
 * mysteriously misses some children.
 *
 * Still strictly better than the zero cross-daemon edges that preceded it,
 * so it ships — but raise it, page it, or order it by something meaningful
 * before relying on it in a fleet that actually overflows.
 */
export const FOREIGN_FETCH_LIMIT = 200;

/** BUTCHR-388: the `Implements` link targets of `matches` that this daemon's own rules do NOT match — the tickets a boss must hear about but cannot see through its own search. */
export function foreignImplementerKeys(matches: readonly RuleMatch[]): string[] {
  const have = new Set(matches.map((m) => m.issue.key));
  const wanted = new Set<string>();
  for (const m of matches)
    for (const link of m.issue.issuelinks ?? [])
      if (link.type === "Implements" && link.otherEnd === "outward" && !have.has(link.key)) wanted.add(link.key);
  return [...wanted].sort();
}

export function specForMatch({ agentKey, rule, issue }: RuleMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: issue.key,
    issuetype: issue.issuetype,
    summary: issue.summary,
    parent: bossKeyFrom(issue),
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/**
 * BUTCHR-398: the SpawnSpec for a `singleton`/`persistent` rule's ONE
 * query-level agent. No `resource` (there is no single ticket — see
 * `SpawnSpec.resource`'s own doc comment) and no `parent` (a query agent has
 * no single ticket to derive a boss from; its own boss routing, if any, is
 * a later story's concern). `brief` is always the rule's own (never
 * `briefFor(issuetype)` — see `buildWorkspace`, src/agents/workspace.ts), so
 * `issuetype: "task"` here only selects model/effort.
 */
export function specForRuleQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every ticket "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

export const specForUnit = (u: ExecutionUnit<RuleMatch>): SpawnSpec => (u.kind === "resource" ? specForMatch(u.match) : specForRuleQuery(u.rule, u.agentKey));

/**
 * Event rules: the issue tier's full suppression stack, reused per RULE.
 * Each SWARM rule gets its own long-lived `createIssueEventRules` instance
 * over just that rule's matched issues (BUTCHR-398: now filtered to
 * `"resource"`-kind primary units — see `resourceMatches` — so a
 * `singleton`/`persistent` rule, which never produces one, is simply never
 * iterated here; unchanged for every swarm rule), so every Jira-shaped
 * decision (status, label, comment, own-write echo) is made exactly as
 * before, and the verdict for issue K under rule R is delivered to agent
 * `R:K` alone. The inner stack's `watcher` is the issue key (its own-agent
 * convention); `suppress` translates it back to the agent key, so one
 * agent's own write is swallowed for that agent but still reaches a second
 * agent on the same ticket.
 *
 * Related changes go through one more instance of the same stack whose
 * watchers ARE agent keys, so a worker agent's own write still reaches its
 * boss. BUTCHR-398 widens what "related" carries: alongside the pre-existing
 * Implements/Relates chain (`relatedForRules`, unchanged), it now also
 * carries every `singleton`/`persistent` rule's own currently-matched
 * tickets, watched by that rule's query agent (`scopeRelatedResources`,
 * src/rules/execution.ts) — the mechanism that delivers scope-wide events
 * (creates, status changes, comments) to the ONE query-level agent. Both
 * sources are merged (`mergeRelated`) before reaching this function, so a
 * ticket named by both (e.g. singleton-scoped AND a boss's implementer) is
 * watched by the union of both watcher sets — this function does not need
 * to know which source(s) contributed a given related entry.
 */
export function createRuleEventRules(deps: Omit<RuleResourceDeps, "search">): EventRules<ExecutionUnit<RuleMatch>> {
  const inner = new Map<string, EventRules<JiraIssue>>();
  const innerFor = (rule: Rule): EventRules<JiraIssue> => {
    let rules = inner.get(rule.id);
    if (!rules) {
      const agentOf = (issueKey: string) => encodeAgentKey({ resourceProvider: rule.resourceProvider, ruleId: rule.id, resourceId: issueKey });
      rules = createIssueEventRules({
        ...(deps.suppress ? { suppress: (key: string, updated: string, watcher: string) => deps.suppress!(key, updated, agentOf(watcher)) } : {}),
        ...(deps.comments ? { comments: deps.comments } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
      inner.set(rule.id, rules);
    }
    return rules;
  };
  const relatedRules = createIssueEventRules({
    ...(deps.suppress ? { suppress: deps.suppress } : {}),
    ...(deps.comments ? { comments: deps.comments } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const asIssues = (related: readonly RelatedResource<ExecutionUnit<RuleMatch>>[]) =>
    related.filter((r) => r.issue.kind === "resource").map((r) => ({ issue: (r.issue as { kind: "resource"; match: RuleMatch }).match.issue, watchers: r.watchers }));
  const issuesFor = (units: readonly ExecutionUnit<RuleMatch>[], ruleId: string) => resourceMatches(units).filter((m) => m.rule.id === ruleId).map((m) => m.issue);

  return {
    async poll(prev: PollSnapshot<ExecutionUnit<RuleMatch>>, next: PollSnapshot<ExecutionUnit<RuleMatch>>): Promise<EventPoll> {
      const polls = new Map<string, EventPoll>();
      const changed: string[] = [];
      for (const rule of deps.rules) {
        const before = issuesFor(prev.primary, rule.id);
        const after = issuesFor(next.primary, rule.id);
        if (!before.length && !after.length && !inner.has(rule.id)) continue;
        const poll = await innerFor(rule).poll({ primary: before, related: [] }, { primary: after, related: [] });
        polls.set(rule.id, poll);
        for (const issueKey of poll.changedPrimary) {
          changed.push(encodeAgentKey({ resourceProvider: rule.resourceProvider, ruleId: rule.id, resourceId: issueKey }));
        }
      }
      // Related entries are one per ticket; the loop addresses them by agent key.
      const relatedEntry = (key: string) => next.related.find((r) => unitAgentKey(r.issue) === key) ?? prev.related.find((r) => unitAgentKey(r.issue) === key);
      const relatedIdOf = (issueKey: string) => {
        const entry = next.related.find((r) => r.issue.kind === "resource" && (r.issue as { kind: "resource"; match: RuleMatch }).match.issue.key === issueKey)
          ?? prev.related.find((r) => r.issue.kind === "resource" && (r.issue as { kind: "resource"; match: RuleMatch }).match.issue.key === issueKey);
        return unitAgentKey(entry!.issue);
      };
      const relatedPoll = prev.related.length || next.related.length
        ? await relatedRules.poll({ primary: [], related: asIssues(prev.related) }, { primary: [], related: asIssues(next.related) })
        : null;
      return {
        changedPrimary: changed,
        changedRelated: relatedPoll ? relatedPoll.changedRelated.map(relatedIdOf) : [],
        async decide(key, watcher, space) {
          if (space === "related") {
            const entry = relatedEntry(key);
            if (!relatedPoll || entry?.issue.kind !== "resource" || !entry.watchers.includes(watcher)) return { deliver: false };
            return relatedPoll.decide(entry.issue.match.issue.key, watcher, "related");
          }
          const parts = decodeAgentKey(key);
          const poll = parts && polls.get(parts.ruleId);
          if (!parts || !poll || watcher !== key) return { deliver: false };
          return poll.decide(parts.resourceId, parts.resourceId, "primary");
        },
      };
    },
  };
}

export function createRuleResourceType(deps: RuleResourceDeps): ResourceType<ExecutionUnit<RuleMatch>> {
  // The loop calls `related` right after `search` in the same poll, so the
  // relationship walk reads this poll's matches with no second Jira call.
  let latest: RuleMatch[] = [];
  const excluded = onceExcluded("jira-work", "not a proven work item", deps.log);
  const linkedDiscoveryTracker = createLinkedDiscoveryTracker();
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchRules({ ...deps, excluded });
        // BUTCHR-429: discovery+logging over this poll's own matches — see
        // `logLinkedDiscovery`'s own doc comment for why this runs
        // unconditionally (no new Jira call, no `linkedEventing` gate).
        logLinkedDiscovery(latest, linkedDiscoveryTracker, deps.log);
        // BUTCHR-398: rename-safety — a running agent whose SHAPE (per-
        // resource vs. query-level) disagrees with its rule's CURRENT
        // execution mode is a deliberate transition, logged loudly rather
        // than silently retired/duplicated. See logExecutionModeSwitches's
        // own doc comment (src/rules/execution.ts).
        if (deps.runningIds) logExecutionModeSwitches("jira-work", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "jira-work");
        return groupExecutionUnits(enabled, latest);
      },
      // BUTCHR-388: an `Implements` target this daemon's own rules do not
      // match is invisible to `search`, so a boss whose implementer is
      // staffed by the OTHER daemon would hear nothing — which is every
      // parent/child pair in a fleet that splits Epic/Task/Bug from
      // Story/Sub-task by account. Fetch those targets by key so the boss
      // can hear them, exactly as the legacy `createRelated` did
      // ("watched regardless of assignee", src/resources/issue.ts).
      // A failed fetch degrades to the same-daemon set rather than throwing
      // the poll away, and says so — never silently.
      //
      // BUTCHR-398: merged with `scopeRelatedResources(latest)` — every
      // `singleton`/`persistent` rule's own currently-matched tickets,
      // watched by that rule's query agent — the Implements/Relates chain
      // (`relatedForRules`) itself is UNCHANGED, still computed over the
      // FULL `latest` (every enabled rule's matches, every execution mode)
      // exactly as before this ticket.
      related: async (active) => {
        const all = foreignImplementerKeys(latest);
        const wanted = all.slice(0, FOREIGN_FETCH_LIMIT);
        // BUTCHR-388: crossing the limit starves the tail for as long as the
        // overflow lasts (see FOREIGN_FETCH_LIMIT), so say so. Without this
        // an overflowing fleet is indistinguishable from a fitting one, and
        // the count that would have told you is discarded on the line above.
        if (all.length > wanted.length) {
          deps.log?.(`  WARNING: [related] ${all.length} cross-rule implementer(s) exceeds FOREIGN_FETCH_LIMIT=${FOREIGN_FETCH_LIMIT}; ${all.length - wanted.length} will NOT be heard while this persists (first ${wanted.length} by key order fetched)`);
        }
        let foreign: JiraIssue[] = [];
        if (wanted.length) {
          try {
            foreign = await deps.search(`key in (${wanted.join(",")})`);
          } catch (e) {
            deps.log?.(`  WARNING: [related] cross-rule fetch failed for ${wanted.length} key(s), hearing same-rule tickets only this poll: ${(e as Error)?.message ?? e}`);
          }
        }
        const crossRule = relatedForRules(deps.rules, latest, active, foreign);
        const wrap = (rs: readonly RelatedResource<RuleMatch>[]): RelatedResource<ExecutionUnit<RuleMatch>>[] =>
          rs.map((r) => ({ issue: { kind: "resource" as const, match: r.issue }, watchers: r.watchers }));
        // BUTCHR-398: `scopeRelatedResources` already returns `"resource"`-kind
        // wrapped entries — only `crossRule` (the pre-existing Implements/
        // Relates output, still bare `RuleMatch`) needs wrapping here.
        return mergeRelated((u) => (u.kind === "resource" ? u.match.issue.key : u.agentKey), wrap(crossRule), scopeRelatedResources(latest));
      },
    },
    activation: { verdictFor: () => "active" },
    eventRules: createRuleEventRules(deps),
    spawnConfig: { specFor: specForUnit },
  };
}

/** Each distinct Jira issue across `units`' `"resource"`-kind (swarm) matches once — for the label/detector layer, which works per ticket. A `singleton`/`persistent` rule's own query-level unit carries no single issue and is not represented here (BUTCHR-398): label sync, parked- and abandoned-worker detection stay per-resource concepts. */
export function uniqueIssues(units: readonly ExecutionUnit<RuleMatch>[]): JiraIssue[] {
  const byKey = new Map<string, JiraIssue>();
  for (const m of resourceMatches(units)) if (!byKey.has(m.issue.key)) byKey.set(m.issue.key, m.issue);
  return [...byKey.values()];
}

/**
 * BUTCHR-429/BUTCHR-431: logs each match's discovered link set
 * (`[linked-discovery]`, src/jira-watch/linked-discovery-log.ts), gated on
 * change per resource via `tracker` so an unchanged set logs nothing after
 * its first poll. Runs for EVERY match regardless of `rule.linkedEventing` —
 * discovery is a cost-free pure parse of data `searchRules` already fetched
 * (`issuelinks`, `parent`, and — as of BUTCHR-431 — `description` are all
 * part of `SEARCH_FIELDS`, src/atlassian/client.ts), so there is no cost
 * this story needs a knob to gate. `issuelinks`, `parent`, and `description`
 * are passed to `discoverLinkedItems` here, plus the match's own key as
 * `ownKey` so a description that mentions its OWN issue is never reported
 * as a link to itself (see `LinkedDiscoverySource.ownKey`'s own doc
 * comment). Remote links are NOT part of what `searchRules` fetches (see
 * src/resources/linked-discovery.ts's own top comment) — that parser still
 * exists for a caller that already has that data, but wiring it here would
 * add a second Jira call this story doesn't make. `rule.maxLinkedItems`
 * (absent = uncapped) bounds what gets logged as kept vs. skipped per match.
 */
export function logLinkedDiscovery(
  matches: readonly RuleMatch[],
  tracker: ReturnType<typeof createLinkedDiscoveryTracker>,
  log: ((line: string) => void) | undefined,
): void {
  for (const m of matches) {
    const items = discoverLinkedItems({
      issuelinks: m.issue.issuelinks,
      parent: m.issue.parent,
      description: m.issue.description,
      ownKey: m.issue.key,
    });
    const { kept, skipped } = capLinkedItems(items, m.rule.maxLinkedItems);
    if (!tracker.changed(m.agentKey, kept, skipped)) continue;
    for (const line of formatLinkedDiscoveryLines(m.agentKey, kept, skipped)) log?.(line);
  }
}

/** Logs each (rule, issue) exclusion once per resource type, not once per poll. */
export function onceExcluded(provider: string, why: string, log: ((line: string) => void) | undefined): ExcludedIssue {
  const logged = new Set<string>();
  return (rule, issue) => {
    const id = `${rule.id}:${issue.key}`;
    if (logged.has(id)) return;
    logged.add(id);
    log?.(`[${provider}] rule ${rule.id} skips ${issue.key}: ${why} (issue type "${issue.issuetype}", project type "${issue.projectType ?? "unknown"}")`);
  };
}
