import type { SpawnSpec } from '../agents/workspace.js';
import type { JiraIssue } from '../atlassian/types.js';
import type { JiraProject } from '../resources/jira-project.js';
import type { NotifyReason, RelatedResource, ResourceType } from '../resources/types.js';
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from '../jira-watch/linked-eventing.js';
import { encodeAgentKey, decodeAnyAgentKey } from './agent-key.js';
import type { Rule } from './rules.js';
export interface ProjectMatch { agentKey: string; rule: Rule; project: JiraProject; spec?: SpawnSpec; }
/** True for exactly the herd ids this type owns — a per-resource key or a query-level one (BUTCHR-397) alike, same convention as every other provider's owns*Agent predicate. */
export const ownsJiraProjectAgent = (id: string) => decodeAnyAgentKey(id)?.resourceProvider === 'jira-project';
export function specForProject(m: ProjectMatch): SpawnSpec {
 return m.spec ?? { key:m.agentKey,resource:m.project.key,issuetype:'project',summary:m.project.name,parent:null,brief:m.rule.brief,
 ...(m.rule.agentPreferences ? {agents:m.rule.agentPreferences}:{}), ...(m.rule.mcpConfigFile ? {mcpConfigFile:m.rule.mcpConfigFile}: {}) };
}

export interface CreateJiraProjectResourceTypeDeps {
  rules: readonly Rule[];
  search: (query: string) => Promise<JiraProject[]>;
  prepare?: (spec: SpawnSpec) => Promise<SpawnSpec>;
  isFrozen?: (id: string) => Promise<boolean>;
  /**
   * BUTCHR-469: raw JQL search for linked-eventing's member-discovery watch
   * (`project = <key> AND updated >= "-<N>m"`) and its shared batched
   * Jira-kind fetch — the SAME `(jql) => Promise<JiraIssue[]>` shape
   * `RuleResourceDeps.search` (src/rules/resource-type.ts) already uses,
   * named differently here only to avoid colliding with this type's own
   * `search` above (which searches PROJECTS via a JSON query, never JQL).
   * Optional; omitted, linked-eventing never runs for `jira-project` owners
   * — the SAME "omitted dep ⇒ feature silently never runs" shape
   * `RuleResourceDeps.notify` already has (every existing caller/test that
   * doesn't wire this is unaffected).
   */
  searchIssues?: (jql: string) => Promise<JiraIssue[]>;
  /** BUTCHR-469: delivers one poll tick's coalesced linked-change nudge — the SAME seam `RuleResourceDeps.notify` already is. Optional; both this AND `searchIssues` must be present for a linked-eventing tick to ever run (see `discovery.related` below). */
  notify?: (agentKey: string, about: string, reason: NotifyReason) => void | Promise<void>;
  /** BUTCHR-469: per-target comment-cursor support for member/managed-link Jira targets — the SAME `LinkedEventingDeps.comments` shape. Optional; omitted, no comment event is ever detected for a project owner (unchanged pre-BUTCHR-469 behaviour). */
  comments?: LinkedEventingDeps['comments'];
  /** BUTCHR-469: the FACTORY-4/FACTORY-8 managed-link store, routed (`createRoutingLinkStore`, src/resources/link-store-router.ts) so a `jira-project:` owner reaches the `brooswit.butchr.links` project-property store. Optional; omitted, no managed link is ever reconciled into a project owner's watch. */
  linkStore?: LinkedEventingDeps['linkStore'];
  log?: (line: string) => void;
  /** Injectable clock, for deterministic tests — threaded straight through to `LinkedEventingDeps.now`. */
  now?: () => number;
}

export function createJiraProjectResourceType(deps: CreateJiraProjectResourceTypeDeps): ResourceType<ProjectMatch> {
 // BUTCHR-469: this poll's own matches, read by `related` below — mirrors
 // `createRuleResourceType`'s own `let latest` (src/rules/resource-type.ts).
 let latest: ProjectMatch[] = [];
 const linkedEventingState = createLinkedEventingState();
 return {
 discovery: {idOf:m=>m.agentKey,search:async()=>{
   const groups=await Promise.all(deps.rules.filter(r=>r.enabled&&r.resourceProvider==='jira-project').map(async rule=>{
    const seen=new Set<string>();const matches:ProjectMatch[]=[];
    for(const project of await deps.search(rule.query)) {
     if(project.archived||seen.has(project.key))continue;seen.add(project.key);
     const m:ProjectMatch={agentKey:encodeAgentKey({resourceProvider:'jira-project',ruleId:rule.id,resourceId:project.key}),rule,project};
     matches.push(m);
    }return matches;
   }));
   const matches=groups.flat();
   if(deps.prepare)for(const m of matches) {
     if (await deps.isFrozen?.(m.agentKey)) continue;
     m.spec=await deps.prepare(specForProject(m));
   }
   latest = matches;
   return matches;
 },
 // BUTCHR-469: linked-change eventing for `jira-project` owners — see
 // `ProjectLinkedEventingMatch`'s own doc comment (src/jira-watch/
 // linked-eventing.ts) for the member-discovery + managed-link design.
 // Mirrors `createRuleResourceType`'s own `related` (src/rules/
 // resource-type.ts): runs AFTER `reconcileNow` has already run this poll
 // (`related` is always called after `reconcileNow` in `runResourceLoop`,
 // src/daemon/loop.ts), so a just-spawned owning agent already exists
 // before this ever tries to nudge it. Belt-and-suspenders try/catch, same
 // discipline as the jira-work path: a failure here must never break this
 // provider's own related-resource contract, which stays trivial (`[]`) —
 // `jira-project` has no related-resource concept of its own, unchanged
 // from before this ticket. Only runs when BOTH `deps.notify` and
 // `deps.searchIssues` are wired; either omitted, no tick ever runs (every
 // existing caller/test that wires neither is completely unaffected).
 related: async () => {
   if (deps.notify && deps.searchIssues) {
     const notify = deps.notify;
     const searchIssues = deps.searchIssues;
     const projectMatches: ProjectLinkedEventingMatch[] = latest.map((m) => ({ agentKey: m.agentKey, rule: m.rule, projectKey: m.project.key }));
     try {
       await linkedEventingState.runTick([], {
         search: searchIssues,
         notify,
         ...(deps.log ? { log: deps.log } : {}),
         ...(deps.now ? { now: deps.now } : {}),
         ...(deps.linkStore ? { linkStore: deps.linkStore } : {}),
         ...(deps.comments ? { comments: deps.comments } : {}),
       }, projectMatches);
     } catch (e) {
       deps.log?.(`  WARNING: [linked-eventing] project tick threw: ${(e as Error)?.message ?? e}`);
     }
   }
   return [] as RelatedResource<ProjectMatch>[];
 },
 },
 activation:{verdictFor:()=> 'active'},
 // Membership controls residency. No ticket/Confluence workflow, auto-assignment, or work prompts.
 eventRules:{poll:async()=>({changedPrimary:[],changedRelated:[],decide:async()=>({deliver:false})})},
 spawnConfig:{specFor:specForProject},
 };
}
