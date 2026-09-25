/**
 * The rule engine's `ResourceType` for `jira-idea` rules: one item per
 * (rule, Jira Product Discovery idea) match, keyed `jira-idea:<rule>:<KEY>`,
 * active exactly while the rule's JQL returns the idea.
 *
 * Ideas share Jira's transport and the issue tier's change detection
 * (status, labels, comments, summary, own-write echoes — reused through
 * `createRuleEventRules`), and nothing else with `jira-work`: their own
 * provider identity, workspace, loop, MCP identity and tools. A JQL result
 * that is not a proven idea is skipped (src/resources/jira-idea.ts), so a
 * `jira-idea` rule never staffs a work item.
 *
 * The one relationship: GitHub issues an idea HEARS (`relatedGithubIssues`).
 * Read-only: links are created only by the explicit tools in
 * src/tools/idea-github-link.ts, and nothing creates issues or ideas. No
 * idea↔work links yet.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { jiraIssueClass, type LinkedGithubIssue } from "../resources/jira-idea.js";
import type { EventPoll, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { createGithubIssueEventRules, type GithubIssueMatch, type GithubIssueResourceDeps } from "./github-issue-type.js";
import { createRuleEventRules, onceExcluded, specForRuleQuery, type ExcludedIssue, type RuleMatch, type RuleResourceDeps } from "./resource-type.js";
import { groupExecutionUnits, logExecutionModeSwitches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

/** True for exactly the herd ids this type owns. */
export const ownsJiraIdeaAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "jira-idea";

/**
 * What the idea loop tracks: its own ideas — `ExecutionUnit<RuleMatch>`,
 * BUTCHR-398, PRIMARY only, `"resource"` (swarm) or `"query"`
 * (`singleton`/`persistent`) — and the GitHub issues its agents hear
 * (`GithubIssueMatch`, bare — RELATED only, never `"query"`-kind: hearing a
 * GitHub rule's own query agent is not a thing this relationship expresses).
 * The two are distinguished structurally: only the idea-side variant ever
 * carries a `"kind"` field.
 */
export type JiraIdeaItem = ExecutionUnit<RuleMatch> | GithubIssueMatch;

const isIdeaUnit = (m: JiraIdeaItem): m is ExecutionUnit<RuleMatch> => "kind" in m;

/** Every enabled `jira-idea` rule's proven ideas. Any failed search rejects the whole poll. */
export async function searchJiraIdeaRules(deps: Pick<RuleResourceDeps, "rules" | "search"> & { excluded?: ExcludedIssue }): Promise<RuleMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "jira-idea");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const seen = new Set<string>();
    const out: RuleMatch[] = [];
    for (const issue of await deps.search(rule.query)) {
      if (jiraIssueClass(issue) !== "idea") { deps.excluded?.(rule, issue); continue; }
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "jira-idea", ruleId: rule.id, resourceId: issue.key }), rule, issue });
    }
    return out;
  }));
  return perRule.flat();
}

export function specForJiraIdea({ agentKey, rule, issue }: RuleMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: issue.key,
    issuetype: "idea",
    summary: issue.summary,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/**
 * The related set: which idea agents hear which GitHub issues.
 *
 * Agent `R:K` (an active idea agent) hears GitHub issue `G` exactly when some
 * `github-issue` rule `C` currently matches `G`, `C` is listed in `R`'s
 * `inwardConnectionRules`, and idea `K` has a Jira remote link to `G`'s web
 * URL. The link says WHICH issue, configuration says WHETHER: an issue linked
 * from the idea but matched only by rules `R` does not list routes nothing,
 * and neither does a matched issue the idea does not link. Direction is one
 * way — nothing routes from an idea to a GitHub agent.
 *
 * One entry per GitHub issue however many rules or ideas connect it; its id
 * is the smallest contributing GitHub agent key.
 */
export function relatedGithubIssues(
  ideas: readonly RuleMatch[],
  active: readonly string[],
  linksOf: (ideaKey: string) => readonly LinkedGithubIssue[],
  github: readonly GithubIssueMatch[],
): RelatedResource<GithubIssueMatch>[] {
  const activeSet = new Set(active);
  const byRef = new Map<string, GithubIssueMatch[]>();
  for (const g of github) byRef.set(g.issue.ref, [...(byRef.get(g.issue.ref) ?? []), g]);
  const out = new Map<string, { issue: GithubIssueMatch; watchers: Set<string> }>();
  for (const idea of ideas) {
    const listens = idea.rule.relationships?.inwardConnectionRules;
    if (!activeSet.has(idea.agentKey) || !listens?.length) continue;
    for (const link of linksOf(idea.issue.key)) {
      for (const g of byRef.get(link.ref) ?? []) {
        if (!listens.includes(g.rule.id)) continue;
        const e = out.get(link.ref);
        if (!e) out.set(link.ref, { issue: g, watchers: new Set([idea.agentKey]) });
        else {
          e.watchers.add(idea.agentKey);
          if (g.agentKey < e.issue.agentKey) e.issue = g;
        }
      }
    }
  }
  return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers].sort() }));
}

export interface JiraIdeaResourceDeps extends RuleResourceDeps {
  /** The `github-issue` loop's latest complete match list; absent or empty when that loop is not running. */
  githubMatches?: () => readonly GithubIssueMatch[];
  /** The GitHub issues one idea's Jira remote links name (src/resources/jira-idea.ts `linkedGithubIssues`). */
  githubLinks?: (ideaKey: string) => Promise<readonly LinkedGithubIssue[]>;
  /** GitHub comments, only to name a heard issue's newest comment in a nudge. */
  githubComments?: GithubIssueResourceDeps["comments"];
  /** Told each poll's complete idea matches — how the link tools check which idea rules match (src/tools/idea-github-link.ts). */
  onMatches?: (matches: readonly RuleMatch[]) => void;
}

/**
 * Event rules: ideas through the Jira rule stack; heard GitHub issues through
 * the `github-issue` change detection (state, comments, title, body, labels,
 * type — never `updated` alone, and never an issue merely entering or leaving
 * the heard set, e.g. a link added or a rule starting to match). A GitHub
 * agent's own comment still reaches the ideas that hear its issue.
 *
 * BUTCHR-398: PRIMARY is passed straight through to `ideaRules` (already
 * `ExecutionUnit<RuleMatch>` — no filtering needed, `discovery.search()`
 * below never produces anything else there). RELATED now mixes TWO
 * relationships (`isIdeaUnit` tells them apart, see `JiraIdeaItem`'s own doc
 * comment): the pre-existing github-issue-hearing entries (unchanged) and a
 * `singleton`/`persistent` idea rule's own scope entries
 * (`scopeRelatedResources`), decided through `ideaRules` itself (the SAME
 * Jira suppression stack a swarm idea agent's own primary changes go
 * through) rather than `githubRules`.
 */
function createJiraIdeaEventRules(deps: JiraIdeaResourceDeps) {
  const ideaRules = createRuleEventRules(deps);
  const githubRules = createGithubIssueEventRules({
    ...(deps.githubComments ? { comments: deps.githubComments } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  // The GitHub stack decides per its own agent; re-key each heard issue by its ref so one issue is one decision.
  const byRef = (related: readonly RelatedResource<JiraIdeaItem>[]): ExecutionUnit<GithubIssueMatch>[] =>
    related.map((r) => r.issue).filter((u): u is GithubIssueMatch => !isIdeaUnit(u)).map((g) => ({ kind: "resource" as const, match: { ...g, agentKey: g.issue.ref } }));
  const ideaRelated = (related: readonly RelatedResource<JiraIdeaItem>[]): RelatedResource<ExecutionUnit<RuleMatch>>[] =>
    related.filter((r) => isIdeaUnit(r.issue)).map((r) => ({ issue: r.issue as ExecutionUnit<RuleMatch>, watchers: r.watchers }));
  return {
    async poll(prev: PollSnapshot<JiraIdeaItem>, next: PollSnapshot<JiraIdeaItem>): Promise<EventPoll> {
      const ideaPrimaryPoll = await ideaRules.poll(
        { primary: prev.primary as ExecutionUnit<RuleMatch>[], related: ideaRelated(prev.related) },
        { primary: next.primary as ExecutionUnit<RuleMatch>[], related: ideaRelated(next.related) },
      );
      const githubPoll = prev.related.length && next.related.length
        ? await githubRules.poll({ primary: byRef(prev.related), related: [] }, { primary: byRef(next.related), related: [] })
        : null;
      const entryFor = (key: string) => next.related.find((r) => !isIdeaUnit(r.issue) && (r.issue as GithubIssueMatch).agentKey === key);
      return {
        changedPrimary: ideaPrimaryPoll.changedPrimary,
        changedRelated: [
          ...ideaPrimaryPoll.changedRelated,
          ...(githubPoll?.changedPrimary ?? []).flatMap((ref) => {
            const e = next.related.find((r) => !isIdeaUnit(r.issue) && (r.issue as GithubIssueMatch).issue.ref === ref);
            return e && !isIdeaUnit(e.issue) ? [(e.issue as GithubIssueMatch).agentKey] : [];
          }),
        ],
        async decide(key, watcher, space) {
          if (space === "primary") return ideaPrimaryPoll.decide(key, watcher, space);
          // Ideas' own scope entries decide through `ideaRules` (the same
          // suppression stack); heard GitHub issues decide through `githubRules`.
          const ideaVerdict = await ideaPrimaryPoll.decide(key, watcher, "related");
          if (ideaVerdict.deliver) return ideaVerdict;
          const entry = entryFor(key);
          if (!githubPoll || !entry?.watchers.includes(watcher)) return { deliver: false };
          const ref = (entry.issue as GithubIssueMatch).issue.ref;
          return githubPoll.decide(ref, ref, "primary");
        },
      };
    },
  };
}

export function createJiraIdeaResourceType(deps: JiraIdeaResourceDeps): ResourceType<JiraIdeaItem> {
  const rules = deps.rules.filter((r) => r.resourceProvider === "jira-idea");
  const excluded = onceExcluded("jira-idea", "not a proven Product Discovery idea", deps.log);
  // `related` runs right after `search` in the same poll, so it reads this poll's ideas.
  let latest: RuleMatch[] = [];
  // Last good read per idea: one failed link read keeps what the idea was
  // heard to link, rather than dropping (and later re-adding) its issues.
  const links = new Map<string, readonly LinkedGithubIssue[]>();
  const failed = new Set<string>();
  const listensTo = (r: Rule, github: readonly GithubIssueMatch[]) =>
    github.some((g) => r.relationships?.inwardConnectionRules?.includes(g.rule.id));

  return {
    discovery: {
      idOf: (m) => (isIdeaUnit(m) ? unitAgentKey(m) : m.agentKey),
      search: async () => {
        latest = await searchJiraIdeaRules({ rules, search: deps.search, excluded });
        deps.onMatches?.(latest);
        if (deps.runningIds) logExecutionModeSwitches("jira-idea", rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        return groupExecutionUnits(rules.filter((r) => r.enabled), latest);
      },
      related: async (active) => {
        const github = deps.githubMatches?.() ?? [];
        const activeSet = new Set(active);
        // BUTCHR-398: an idea's OWN scope entries — every `singleton`/
        // `persistent` idea rule's currently-matched ideas, watched by that
        // rule's query agent — independent of `githubLinks`/`github` below.
        const scoped: RelatedResource<JiraIdeaItem>[] = scopeRelatedResources(latest);
        // Links are read only for active ideas whose rule lists a rule that matches something now.
        const keys = [...new Set(latest.filter((m) => activeSet.has(m.agentKey) && listensTo(m.rule, github)).map((m) => m.issue.key))];
        if (!deps.githubLinks || !keys.length) { links.clear(); failed.clear(); return scoped; }
        for (const k of [...links.keys()]) if (!keys.includes(k)) links.delete(k);
        for (const k of [...failed]) if (!keys.includes(k)) failed.delete(k);
        await Promise.all(keys.map(async (k) => {
          try {
            links.set(k, await deps.githubLinks!(k));
            failed.delete(k);
          } catch (e) {
            if (!failed.has(k)) deps.log?.(`WARNING: [jira-idea] remote links for ${k} failed; keeping the last read: ${(e as Error)?.message ?? e}`);
            failed.add(k);
          }
        }));
        return [...scoped, ...relatedGithubIssues(latest, active, (k) => links.get(k) ?? [], github)];
      },
    },
    activation: { verdictFor: () => "active" },
    eventRules: createJiraIdeaEventRules({ ...deps, rules }),
    spawnConfig: { specFor: (m) => (isIdeaUnit(m) ? (m.kind === "resource" ? specForJiraIdea(m.match) : specForRuleQuery(m.rule, m.agentKey)) : specForJiraIdea(m as unknown as RuleMatch)) },
  };
}
