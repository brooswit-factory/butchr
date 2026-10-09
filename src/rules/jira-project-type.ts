import type { SpawnSpec } from '../agents/workspace.js';
import type { JiraIssue } from '../atlassian/types.js';
import type { JiraProject } from '../resources/jira-project.js';
import type { NotifyReason, PollSnapshot, RelatedResource, ResourceType } from '../resources/types.js';
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from '../jira-watch/linked-eventing.js';
import { createProjectEventRules, projectKeyOfIssue, type ProjectResource, type ProjectResourceDeps } from '../resources/project.js';
import { encodeAgentKey, decodeAnyAgentKey } from './agent-key.js';
import type { Rule } from './rules.js';
export interface ProjectMatch {
  agentKey: string;
  rule: Rule;
  project: JiraProject;
  spec?: SpawnSpec;
  /**
   * FACTORY-981 (story FACTORY-979): every ticket key IN THIS PROJECT
   * currently carrying `agent:blocked`, this poll — the SAME project-wide,
   * orphan-task-inclusive shape as `ProjectResource.observedBlockedKeys`
   * (src/resources/project.ts), computed here by `discovery.search` via
   * `deps.searchIssues` (see that function's own comment) rather than
   * `loadProjects`'s JQL reader, since the live `jira-project` path's own
   * discovery is `ProjectMatch`, never `ProjectResource`. Absent (no
   * `deps.searchIssues` wired) means this axis simply never fires — the
   * same "omitted dep ⇒ feature silently never runs" shape this file's
   * `related` already uses.
   */
  observedBlockedKeys?: readonly string[];
  /** FACTORY-981: the stalled twin of `observedBlockedKeys` above — see that field's own doc comment. */
  observedStalledKeys?: readonly string[];
}
/** True for exactly the herd ids this type owns — a per-resource key or a query-level one (BUTCHR-397) alike, same convention as every other provider's owns*Agent predicate. */
export const ownsJiraProjectAgent = (id: string) => decodeAnyAgentKey(id)?.resourceProvider === 'jira-project';
/** FACTORY-95: `jira-project`'s own short herdr-workspace-label id — the operator's spec names this case as "the project key", and a `jira-project` resourceId already IS that key (`encodeAgentKey`'s `resourceId`, set from `project.key` below), so this is the identity function — see `jiraWorkShortDisplayId` (src/rules/resource-type.ts) for why every provider keeps its own named export rather than sharing one. */
export const jiraProjectShortDisplayId = (resourceId: string): string => resourceId;

/**
 * FACTORY-941: per-agentKey pinned-active minutes override, resolved fresh
 * from one poll's own `ProjectMatch[]` — reuses the SAME `idlePokeMinutes`
 * `Rule` field the issue tier's idle-poke engine reads (src/agents/
 * idle-poke.ts), applied here to `jira-project` rules instead (never a
 * second, pinned-active-only config field — see
 * `PinnedActiveDetectorDeps.minutesFor`'s own doc comment, src/agents/
 * pinned-active.ts, for the contract this feeds). Unlike the issue tier's
 * own `idlePokeRuleConfigByIssue` (src/daemon/index.ts), no "smallest
 * explicit value wins" multi-rule resolution is needed: a `ProjectMatch
 * .agentKey` already encodes the ONE rule that matched it (`encodeAgentKey`'s
 * own `ruleId` component above) — two rules matching the same project
 * produce two DIFFERENT agentKeys, never one agentKey with two candidate
 * rules to arbitrate between. A disabled rule, or one that leaves
 * `idlePokeMinutes` unset, simply has no entry — the caller's own fallback
 * (the global `minutes`) applies exactly as it does for any other id.
 */
export function pinnedActiveMinutesFor(matches: readonly ProjectMatch[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const m of matches) {
    if (!m.rule.enabled) continue;
    if (m.rule.idlePokeMinutes !== undefined) result.set(m.agentKey, m.rule.idlePokeMinutes);
  }
  return result;
}
export function specForProject(m: ProjectMatch): SpawnSpec {
 return m.spec ?? { key:m.agentKey,resource:m.project.key,issuetype:'project',summary:m.project.name,parent:null,brief:m.rule.brief,
 ...(m.rule.agentPreferences ? {agents:m.rule.agentPreferences}:{}), ...(m.rule.mcpConfigFile ? {mcpConfigFile:m.rule.mcpConfigFile}: {}),
 // FACTORY-87: overrides agentLaunchConfig's own unconditional jira-project `permissionMode: "auto"` default (src/agents/argv.ts) only when set.
 ...(m.rule.permissionMode ? {permissionMode:m.rule.permissionMode}: {}),
 // FACTORY-108: a jira-project Codex agent already launches with bypassApprovalsAndSandbox:false unconditionally (agentLaunchConfig's own jira-project special case) regardless of this field, so forwarding it here changes no argv — kept for consistency with every other provider's own permissionMode/lizardMode pairing.
 ...(m.rule.lizardMode ? {lizardMode:true}: {}) };
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
  /** FACTORY-981: the manager blocked-wake debounce window — see `ProjectResourceDeps.blockedWakeDebounceMinutes`'s own doc comment (src/resources/project.ts). Threaded straight through to `createProjectEventRules`; omitted, that function's own default applies. */
  blockedWakeDebounceMinutes?: ProjectResourceDeps['blockedWakeDebounceMinutes'];
  /** FACTORY-981: the manager stalled-wake debounce window — see `ProjectResourceDeps.stalledWakeDebounceMinutes`'s own doc comment. */
  stalledWakeDebounceMinutes?: ProjectResourceDeps['stalledWakeDebounceMinutes'];
  /** FACTORY-981: the manager's own hourly rate cap on delivered stalled wakes — see `ProjectResourceDeps.stalledWakeMaxPerHour`'s own doc comment. */
  stalledWakeMaxPerHour?: ProjectResourceDeps['stalledWakeMaxPerHour'];
  /** FACTORY-981: the `/health` counter writer for a delivered manager stalled wake — see `ProjectResourceDeps.onStalledWake`'s own doc comment. */
  onStalledWake?: ProjectResourceDeps['onStalledWake'];
  /** FACTORY-981: the `/health` counter writer for a manager stalled wake the hourly cap rejected — see `ProjectResourceDeps.onStalledWakeCapped`'s own doc comment. */
  onStalledWakeCapped?: ProjectResourceDeps['onStalledWakeCapped'];
}

export function createJiraProjectResourceType(deps: CreateJiraProjectResourceTypeDeps): ResourceType<ProjectMatch> {
 // BUTCHR-469: this poll's own matches, read by `related` below — mirrors
 // `createRuleResourceType`'s own `let latest` (src/rules/resource-type.ts).
 let latest: ProjectMatch[] = [];
 const linkedEventingState = createLinkedEventingState();
 // FACTORY-981 (story FACTORY-979): ONE instance, built once (not per poll),
 // so its own cross-poll debounce/dedupe state (`blockedWakeFired`,
 // `stalledWakeFired`, the stalled hourly `RateCap` — all private to
 // `createProjectEventRules`'s closure, src/resources/project.ts) persists
 // exactly the way `createIssueEventRules`'s own equivalent state already
 // does, rather than resetting (and re-firing) every poll.
 const projectEventRules = createProjectEventRules({
   ...(deps.comments ? { comments: deps.comments } : {}),
   ...(deps.blockedWakeDebounceMinutes !== undefined ? { blockedWakeDebounceMinutes: deps.blockedWakeDebounceMinutes } : {}),
   ...(deps.stalledWakeDebounceMinutes !== undefined ? { stalledWakeDebounceMinutes: deps.stalledWakeDebounceMinutes } : {}),
   ...(deps.stalledWakeMaxPerHour !== undefined ? { stalledWakeMaxPerHour: deps.stalledWakeMaxPerHour } : {}),
   ...(deps.onStalledWake ? { onStalledWake: deps.onStalledWake } : {}),
   ...(deps.onStalledWakeCapped ? { onStalledWakeCapped: deps.onStalledWakeCapped } : {}),
 });
 // FACTORY-981: adapts a `ProjectMatch` into the `ProjectResource` shape
 // `createProjectEventRules` actually diffs/decides over — `key` is set to
 // this match's own AGENT KEY (never the bare project key): `EventPoll
 // .changedPrimary`/`.decide`'s own `key` argument is whatever this type's
 // `discovery.idOf` produced (`m.agentKey`), and `createProjectEventRules`'s
 // internal `nextByKey`/rate-cap bookkeeping is keyed off exactly the `key`
 // field reused here — so this is the ONLY value that keeps the two
 // consistent. Every version/comment/epic axis is pinned to its own
 // never-behind baseline (`observedVersion: null`, empty comment/epic sets,
 // a `null`-version empty watermark): the live `jira-project` path has no
 // Confluence root-doc/epic concept of its own (`activation.verdictFor`
 // above always answers `"active"` — membership alone controls residency),
 // so `projectVerdict`'s fallback branch (`createProjectEventRules`'s own
 // last line) must always see "fully caught up" (`"asleep"`, never
 // `"active"`) rather than spuriously firing on an axis this provider does
 // not have. Only `observedBlockedKeys`/`observedStalledKeys` ever carry
 // real content, from `discovery.search`'s own JQL reads above.
 const EMPTY_WATERMARK = { version: null, commentsSeen: [], epicsSeen: {} };
 const toProjectResource = (m: ProjectMatch): ProjectResource => ({
   key: m.agentKey,
   name: m.project.name,
   eligible: true,
   rootDocId: null,
   observedVersion: null,
   observedCommentIds: [],
   observedEpics: [],
   unseenCommentIds: [],
   unseenEpicCommentIds: {},
   watermark: EMPTY_WATERMARK,
   observedBlockedKeys: m.observedBlockedKeys ?? [],
   observedStalledKeys: m.observedStalledKeys ?? [],
 });
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
   // FACTORY-981 (story FACTORY-979): one project-wide, orphan-task-inclusive
   // blocked/stalled read — the SAME two JQL searches `loadProjects`
   // (src/resources/project.ts) runs for the `ProjectResource` tier, batched
   // ONCE across every distinct project key this poll matched (not per rule,
   // not per project) and split back out with the SAME `projectKeyOfIssue`
   // helper that module exports for exactly this reuse. Skipped entirely when
   // `deps.searchIssues` is omitted (same "feature silently never runs" shape
   // `related` below already has) or nothing matched this poll.
   if (deps.searchIssues && matches.length) {
     const keys = [...new Set(matches.map((m) => m.project.key))];
     const [blockedTickets, stalledTickets] = await Promise.all([
       deps.searchIssues(`project IN (${keys.join(",")}) AND labels = "agent:blocked"`),
       deps.searchIssues(`project IN (${keys.join(",")}) AND labels = "agent:stalled"`),
     ]);
     const blockedByProject = new Map<string, string[]>();
     for (const t of blockedTickets) {
       const k = projectKeyOfIssue(t.key);
       (blockedByProject.get(k) ?? blockedByProject.set(k, []).get(k)!).push(t.key);
     }
     const stalledByProject = new Map<string, string[]>();
     for (const t of stalledTickets) {
       const k = projectKeyOfIssue(t.key);
       (stalledByProject.get(k) ?? stalledByProject.set(k, []).get(k)!).push(t.key);
     }
     for (const m of matches) {
       m.observedBlockedKeys = blockedByProject.get(m.project.key) ?? [];
       m.observedStalledKeys = stalledByProject.get(m.project.key) ?? [];
     }
   }
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
 // Membership controls residency. No ticket/Confluence workflow,
 // auto-assignment, or work prompts — except the blocked/stalled
 // project-manager wake (FACTORY-981, story FACTORY-979), delegated whole
 // to `createProjectEventRules` via the `toProjectResource` adapter above;
 // `changedRelated` stays permanently empty (`jira-project` has no related-
 // resource concept, same as `discovery.related` above).
 eventRules:{
   poll: (prev: PollSnapshot<ProjectMatch>, next: PollSnapshot<ProjectMatch>) =>
     projectEventRules.poll(
       { primary: prev.primary.map(toProjectResource), related: [] },
       { primary: next.primary.map(toProjectResource), related: [] },
     ),
 },
 spawnConfig:{specFor:specForProject},
 };
}
