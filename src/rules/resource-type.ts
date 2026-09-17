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
 * Deliberately NOT here (later slices): the cross-rule relationship graph
 * (`childRule`/`inwardConnectionRules` are carried but not acted on), related
 * resources, and stand-down sleep.
 */
import type { JiraIssue } from "../atlassian/types.js";
import type { SpawnSpec } from "../agents/workspace.js";
import { bossKeyFrom, createIssueEventRules, type IssueResourceDeps } from "../resources/issue.js";
import type { EventPoll, EventRules, PollSnapshot, ResourceType } from "../resources/types.js";
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

/** True for exactly the herd ids this engine owns — never a legacy bare-issue or project id. */
export const ownsRuleAgent = (id: string): boolean => decodeAgentKey(id) !== null;

/**
 * Every enabled rule's matches. Rules are searched in parallel; ANY failure
 * rejects the whole poll, never a partial result — a partial result would
 * read as "those tickets left the query" and stop healthy agents.
 */
export async function searchRules(deps: Pick<RuleResourceDeps, "rules" | "search">): Promise<RuleMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "jira-work");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const issues = await deps.search(rule.query);
    const seen = new Set<string>();
    const out: RuleMatch[] = [];
    for (const issue of issues) {
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: rule.resourceProvider, ruleId: rule.id, resourceId: issue.key }), rule, issue });
    }
    return out;
  }));
  return perRule.flat();
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
      return {
        changedPrimary: changed,
        changedRelated: [],
        async decide(key, watcher, space) {
          const parts = decodeAgentKey(key);
          const poll = parts && polls.get(parts.ruleId);
          if (!parts || !poll || space !== "primary" || watcher !== key) return { deliver: false };
          return poll.decide(parts.resourceId, parts.resourceId, "primary");
        },
      };
    },
  };
}

export function createRuleResourceType(deps: RuleResourceDeps): ResourceType<RuleMatch> {
  return {
    discovery: { idOf: (m) => m.agentKey, search: () => searchRules(deps) },
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
