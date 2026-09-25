/**
 * The rule engine's `ResourceType` for `github-issue` rules: one item per
 * (rule, GitHub issue) match, keyed `github-issue:<rule>:<owner/repo#n>`,
 * active exactly while the rule's query returns the issue.
 *
 * Kept apart from the Jira rule type (./resource-type.ts) on purpose: the two
 * share the generic loop, agent keys and rule schema, and nothing else.
 * A `github-issue` rule has no relationships of its own; its matches are
 * shared (`onMatches`) so `jira-idea` rules that list it can hear them.
 *
 * Notifications carry identity and a reason, never GitHub-authored text:
 * titles, bodies and comments can be written by anyone who can open an
 * issue, so an agent re-reads them itself rather than having them pushed
 * into its prompt.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { scopedIssueQuery, type GithubComment, type GithubIssue } from "../resources/github-issue.js";
import { parseGithubIssueRef, type GithubIssueRef } from "../resources/github-issue-ref.js";
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface GithubIssueMatch {
  agentKey: string;
  rule: Rule;
  issue: GithubIssue;
}

export interface GithubIssueResourceDeps {
  /** Validated rules; only enabled `github-issue` rules are searched. */
  rules: readonly Rule[];
  /** Every issue one rule query matches (already org-scoped by the client). */
  search: (query: string) => Promise<GithubIssue[]>;
  /** Comments on one issue, oldest first — used only to name the newest comment in a notification reason. */
  comments?: (ref: GithubIssueRef) => Promise<readonly GithubComment[]>;
  /** True when a change to `resource` (now at `updated`) is `watcher`'s own write — e.g. its own comment — and not worth a nudge. */
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  log?: (line: string) => void;
  /** Told each poll's complete match list — how `jira-idea` rules hear the issues they list (src/rules/jira-idea-type.ts). */
  onMatches?: (matches: readonly GithubIssueMatch[]) => void;
  /** BUTCHR-398: this provider's own running herd ids, for `logExecutionModeSwitches` — see `RuleResourceDeps.runningIds`'s own doc comment (src/rules/resource-type.ts). Optional; omitted, no mode-switch logging runs. */
  runningIds?: () => Promise<readonly string[]>;
}

/** True for exactly the herd ids this type owns — a per-resource key or a query-level one (BUTCHR-397) alike. */
export const ownsGithubIssueAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "github-issue";

/** Every enabled `github-issue` rule's matches. Any failed search rejects the whole poll. */
export async function searchGithubIssueRules(deps: Pick<GithubIssueResourceDeps, "rules" | "search">): Promise<GithubIssueMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "github-issue");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const seen = new Set<string>();
    const out: GithubIssueMatch[] = [];
    for (const issue of await deps.search(rule.query)) {
      if (seen.has(issue.ref)) continue;
      seen.add(issue.ref);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "github-issue", ruleId: rule.id, resourceId: issue.ref }), rule, issue });
    }
    return out;
  }));
  return perRule.flat();
}

export function specForGithubIssue({ agentKey, rule, issue }: GithubIssueMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: issue.ref,
    issuetype: issue.issueType?.toLowerCase() ?? "issue",
    summary: issue.title,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/**
 * BUTCHR-398: the SpawnSpec for a `singleton`/`persistent` rule's ONE
 * query-level agent — no single resource (`resource` is omitted, same "no
 * single resource" contract `SpawnSpec.resource`'s own doc comment states),
 * so no GitHub tool can be misled into resolving it as an issue ref. `brief`
 * is always the rule's own (never `briefFor(issuetype)` — see `buildWorkspace`,
 * src/agents/workspace.ts), so `issuetype: "task"` here only selects
 * model/effort, not brief content.
 */
export function specForGithubIssueQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every issue "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

export const specForGithubIssueUnit = (u: ExecutionUnit<GithubIssueMatch>): SpawnSpec =>
  u.kind === "resource" ? specForGithubIssue(u.match) : specForGithubIssueQuery(u.rule, u.agentKey);

/** The fields whose change is worth telling an agent about. `updated` alone is not one of them. */
const observed = (m: GithubIssueMatch) => JSON.stringify([m.issue.title, m.issue.body, m.issue.state, m.issue.stateReason, m.issue.issueType, m.issue.labels, m.issue.comments]);

async function decideGithubIssue(from: GithubIssue, to: GithubIssue, key: string, deps: Pick<GithubIssueResourceDeps, "comments" | "suppress" | "log">): Promise<EventVerdict> {
  if (deps.suppress?.(to.ref, to.updated, key)) return { deliver: false };
  if (from.state !== to.state) return { deliver: true, reason: { status: { from: from.state, to: to.state } } };
  if (to.comments > from.comments) return { deliver: true, reason: await newCommentReason(to, deps) };
  if (from.title !== to.title) return { deliver: true, reason: { summary: true } };
  return { deliver: true };
}

/** `{ comment: id }` when the newest comment can be read; otherwise says why it could not. */
async function newCommentReason(issue: GithubIssue, deps: Pick<GithubIssueResourceDeps, "comments" | "log">): Promise<NotifyReason> {
  const ref = parseGithubIssueRef(issue.ref);
  if (!deps.comments || !ref) return { undetermined: "unchecked" };
  try {
    const id = (await deps.comments(ref)).at(-1)?.id;
    return id ? { comment: id } : { undetermined: "checked-unchanged" };
  } catch (e) {
    deps.log?.(`WARNING: [github-issue] comments for ${issue.ref} failed: ${(e as Error)?.message ?? e}`);
    return { undetermined: "check-failed" };
  }
}

/**
 * Change detection over (prev, next) matches, per agent key. An issue
 * entering or leaving a rule's query is not a notification — the reconciler
 * spawns or stops its agent (swarm), or the issue's presence/absence in a
 * `singleton`/`persistent` rule's own scope is reported as `{ appeared: …
 * }`/`{ disappeared: … }` via the RELATED path below (BUTCHR-398). A change
 * GitHub reports only through `updated` (a reaction, a subscription) is not
 * one either.
 *
 * Reason precedence: state, then a new comment (its id, when `comments` can
 * name it), then title; any other observed change delivers without a reason.
 *
 * BUTCHR-398: PRIMARY covers only `"resource"`-kind units (swarm agents,
 * unchanged from before this ticket — see `resourceMatches`). RELATED covers
 * every `singleton`/`persistent` rule's own currently-matched issues
 * (`scopeRelatedResources`, src/rules/execution.ts), watcher = that rule's
 * query agent key — the SAME diff (`diffMatches`/`decideGithubIssue`) run
 * over a different input list, so a query agent hears an issue's state/
 * comment/title changes exactly as a swarm agent would for its own issue.
 */
export function createGithubIssueEventRules(deps: Pick<GithubIssueResourceDeps, "comments" | "suppress" | "log">): EventRules<ExecutionUnit<GithubIssueMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<GithubIssueMatch>>, next: PollSnapshot<ExecutionUnit<GithubIssueMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), observed);
      const relatedOf = (related: readonly RelatedResource<ExecutionUnit<GithubIssueMatch>>[]) =>
        related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: GithubIssueMatch } => u.kind === "resource").map((u) => u.match);
      const relatedDiff = diffMatches(relatedOf(prev.related), relatedOf(next.related), observed);
      const relatedEntry = (key: string) =>
        next.related.find((r) => unitAgentKey(r.issue) === key) ?? prev.related.find((r) => unitAgentKey(r.issue) === key);
      return {
        changedPrimary: primaryDiff.changed,
        changedRelated: relatedDiff.changed,
        async decide(key, watcher, space): Promise<EventVerdict> {
          if (space === "primary") {
            const pair = primaryDiff.pairFor(key);
            if (watcher !== key || !pair) return { deliver: false };
            return decideGithubIssue(pair.from.issue, pair.to.issue, key, deps);
          }
          const pair = relatedDiff.pairFor(key);
          const entry = relatedEntry(key);
          if (!pair || !entry?.watchers.includes(watcher)) return { deliver: false };
          return decideGithubIssue(pair.from.issue, pair.to.issue, key, deps);
        },
      };
    },
  };
}

export function createGithubIssueResourceType(deps: GithubIssueResourceDeps): ResourceType<ExecutionUnit<GithubIssueMatch>> {
  let latest: GithubIssueMatch[] = [];
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchGithubIssueRules(deps);
        deps.onMatches?.(latest);
        if (deps.runningIds) logExecutionModeSwitches("github-issue", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "github-issue");
        return groupExecutionUnits(enabled, latest);
      },
      // BUTCHR-398: scope-ownership — every `singleton`/`persistent` rule's
      // own currently-matched issues, watched by that rule's query agent.
      // `github-issue` has no other related source (no Implements/Relates
      // chain — see this module's own top comment), so no merge is needed.
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createGithubIssueEventRules(deps),
    spawnConfig: { specFor: specForGithubIssueUnit },
  };
}

/**
 * Whether this daemon may run `github-issue` rules, decided once at startup.
 * Fails closed: without GitHub auth and org scope, or with any enabled rule
 * whose query cannot be scoped to those orgs, NO github-issue rule runs and
 * nothing is spawned for one — the reason says why. Jira rules are unaffected.
 */
export type GithubIssueStaffing =
  | { run: true; rules: Rule[] }
  | { run: false; rules: Rule[]; reason: string | null };

export function githubIssueStaffing(rules: readonly Rule[], github: { token: string; orgs: readonly string[] } | undefined): GithubIssueStaffing {
  const enabled = rules.filter((r) => r.enabled && r.resourceProvider === "github-issue");
  if (!enabled.length) return { run: false, rules: [], reason: null };
  const ids = enabled.map((r) => r.id).join(", ");
  if (!github?.token || !github.orgs.length) return { run: false, rules: enabled, reason: `github-issue rules not staffed (${ids}): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS` };
  const problems: string[] = [];
  for (const r of enabled) {
    try { scopedIssueQuery(r.query, github.orgs); } catch (e) { problems.push(`${r.id}: ${(e as Error).message}`); }
  }
  if (problems.length) return { run: false, rules: enabled, reason: `github-issue rules not staffed (${ids}): ${problems.join("; ")}` };
  return { run: true, rules: enabled };
}
