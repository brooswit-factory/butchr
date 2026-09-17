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
 * `jira-idea` rule never staffs a work item. No relationships and no
 * idea↔work links yet.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { jiraIssueClass } from "../resources/jira-idea.js";
import type { ResourceType } from "../resources/types.js";
import { decodeAgentKey, encodeAgentKey } from "./agent-key.js";
import { createRuleEventRules, onceExcluded, type ExcludedIssue, type RuleMatch, type RuleResourceDeps } from "./resource-type.js";

/** True for exactly the herd ids this type owns. */
export const ownsJiraIdeaAgent = (id: string): boolean => decodeAgentKey(id)?.resourceProvider === "jira-idea";

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

export function createJiraIdeaResourceType(deps: RuleResourceDeps): ResourceType<RuleMatch> {
  const rules = deps.rules.filter((r) => r.resourceProvider === "jira-idea");
  const excluded = onceExcluded("jira-idea", "not a proven Product Discovery idea", deps.log);
  return {
    discovery: { idOf: (m) => m.agentKey, search: () => searchJiraIdeaRules({ rules, search: deps.search, excluded }) },
    activation: { verdictFor: () => "active" },
    eventRules: createRuleEventRules({ ...deps, rules }),
    spawnConfig: { specFor: specForJiraIdea },
  };
}
