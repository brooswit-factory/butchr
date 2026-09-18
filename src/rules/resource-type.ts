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
import type { EventPoll, EventRules, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAgentKey, encodeAgentKey } from "./agent-key.js";
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
}

/** True for exactly the `jira-work` herd ids this engine owns — never a legacy bare-issue or project id, nor another provider's agent. */
export const ownsRuleAgent = (id: string): boolean => decodeAgentKey(id)?.resourceProvider === "jira-work";

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
 * Agent `R:B` hears ticket `W` exactly when, for some rule `C` matching `W`,
 * one of these holds:
 * - up (boss hears worker): `C` is `R`'s `childRule` and Jira has `W`
 *   implementing `B` — an `Implements` link with `W` on the implementer side;
 * - inward (sideways): `C` is in `R`'s `inwardConnectionRules` and Jira has
 *   `W` and `B` joined by a `Relates` link, either way round.
 * Links are read from either ticket's `issuelinks`.
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
 * One entry per heard TICKET, however many rules or links connect it, so a
 * listener hears one change once. Its id is the smallest contributing agent
 * key — any stable member works, since routing reads the ticket, not the rule.
 */
export function relatedForRules(rules: readonly Rule[], matches: readonly RuleMatch[], active: readonly string[]): RelatedResource<RuleMatch>[] {
  const activeSet = new Set(active);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const hears: Record<"child" | "inward", (listener: Rule, source: Rule) => boolean> = {
    child: (listener, source) => byId.get(listener.id)?.relationships?.childRule === source.id,
    inward: (listener, source) => byId.get(listener.id)?.relationships?.inwardConnectionRules?.includes(source.id) ?? false,
  };
  const byIssue = new Map<string, RuleMatch[]>();
  for (const m of matches) byIssue.set(m.issue.key, [...(byIssue.get(m.issue.key) ?? []), m]);

  const out = new Map<string, { issue: RuleMatch; watchers: Set<string> }>();
  const edge = (sourceKey: string, listenerKey: string, kind: "child" | "inward") => {
    if (sourceKey === listenerKey) return;
    for (const listener of byIssue.get(listenerKey) ?? []) {
      if (!activeSet.has(listener.agentKey)) continue;
      for (const source of byIssue.get(sourceKey) ?? []) {
        if (!hears[kind](listener.rule, source.rule)) continue;
        const e = out.get(sourceKey);
        if (!e) out.set(sourceKey, { issue: source, watchers: new Set([listener.agentKey]) });
        else {
          e.watchers.add(listener.agentKey);
          if (source.agentKey < e.issue.agentKey) e.issue = source;
        }
      }
    }
  };
  for (const [key, ms] of byIssue) {
    for (const link of ms[0]!.issue.issuelinks ?? []) {
      if (link.type === "Implements") {
        if (link.otherEnd === "inward") edge(key, link.key, "child");
        else edge(link.key, key, "child");
      } else if (link.type === "Relates") {
        edge(key, link.key, "inward");
        edge(link.key, key, "inward");
      }
    }
  }
  return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers].sort() }));
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
 * Event rules: the issue tier's full suppression stack, reused per RULE.
 * Each rule gets its own long-lived `createIssueEventRules` instance over just
 * that rule's matched issues, so every Jira-shaped decision (status, label,
 * comment, own-write echo) is made exactly as before, and the verdict for
 * issue K under rule R is delivered to agent `R:K` alone. The inner stack's
 * `watcher` is the issue key (its own-agent convention); `suppress` translates
 * it back to the agent key, so one agent's own write is swallowed for that
 * agent but still reaches a second agent on the same ticket.
 *
 * Related changes (a ticket heard by other rule agents, see `relatedForRules`) go
 * through one more instance of the same stack whose watchers ARE agent keys,
 * so a worker agent's own write still reaches its boss.
 */
export function createRuleEventRules(deps: Omit<RuleResourceDeps, "search">): EventRules<RuleMatch> {
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
  const asIssues = (related: readonly RelatedResource<RuleMatch>[]) => related.map((r) => ({ issue: r.issue.issue, watchers: r.watchers }));
  const issuesFor = (matches: readonly RuleMatch[], ruleId: string) => matches.filter((m) => m.rule.id === ruleId).map((m) => m.issue);

  return {
    async poll(prev: PollSnapshot<RuleMatch>, next: PollSnapshot<RuleMatch>): Promise<EventPoll> {
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
      const relatedEntry = (key: string) => next.related.find((r) => r.issue.agentKey === key) ?? prev.related.find((r) => r.issue.agentKey === key);
      const relatedIdOf = (issueKey: string) =>
        (next.related.find((r) => r.issue.issue.key === issueKey) ?? prev.related.find((r) => r.issue.issue.key === issueKey))!.issue.agentKey;
      const relatedPoll = prev.related.length || next.related.length
        ? await relatedRules.poll({ primary: [], related: asIssues(prev.related) }, { primary: [], related: asIssues(next.related) })
        : null;
      return {
        changedPrimary: changed,
        changedRelated: relatedPoll ? relatedPoll.changedRelated.map(relatedIdOf) : [],
        async decide(key, watcher, space) {
          if (space === "related") {
            const entry = relatedEntry(key);
            if (!relatedPoll || !entry?.watchers.includes(watcher)) return { deliver: false };
            return relatedPoll.decide(entry.issue.issue.key, watcher, "related");
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

export function createRuleResourceType(deps: RuleResourceDeps): ResourceType<RuleMatch> {
  // The loop calls `related` right after `search` in the same poll, so the
  // relationship walk reads this poll's matches with no second Jira call.
  let latest: RuleMatch[] = [];
  const excluded = onceExcluded("jira-work", "not a proven work item", deps.log);
  return {
    discovery: {
      idOf: (m) => m.agentKey,
      search: async () => (latest = await searchRules({ ...deps, excluded })),
      related: async (active) => relatedForRules(deps.rules, latest, active),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createRuleEventRules(deps),
    spawnConfig: { specFor: specForMatch },
  };
}

/** Each distinct Jira issue across `matches` once — for the label/detector layer, which works per ticket. */
export function uniqueIssues(matches: readonly RuleMatch[]): JiraIssue[] {
  const byKey = new Map<string, JiraIssue>();
  for (const m of matches) if (!byKey.has(m.issue.key)) byKey.set(m.issue.key, m.issue);
  return [...byKey.values()];
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
