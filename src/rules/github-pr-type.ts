/**
 * FACTORY-57 (implementing FACTORY-56, epic FACTORY-55): the rule engine's
 * `ResourceType` for `github-pr` rules: one item per (rule, GitHub pull
 * request) match, keyed `github-pr:<rule>:<owner/repo#n>`, active exactly
 * while the rule's query returns the PR. Deliberate mirror of
 * `./github-issue-type.ts` — see that module's own header for the shared
 * design this one repeats with pull request in place of issue.
 *
 * LIFECYCLE AT MERGE/CLOSE, DEFINED EXPLICITLY (ticket requirement): this
 * type has NO special-cased merge/close handling of its own — it is driven
 * purely by whether the rule's own query still returns the PR on the next
 * poll, exactly the same mechanism `github-issue` already uses for a closed
 * issue (see that module's own header: an issue/PR leaving a rule's query is
 * not itself a notification — the swarm reconciler spawns or stops the
 * matching agent). A rule whose query is (or narrows to) `is:open` — the
 * recommended default, and GitHub's own search treats a merged PR as
 * `state:closed` exactly like a closed-without-merging one — stops seeing a
 * PR the moment GitHub reports it merged OR closed, so the reconciler stops
 * that PR's agent on the very next poll; a rule that deliberately queries
 * merged/closed PRs too (e.g. to keep working post-merge follow-ups) keeps
 * its agent running, by the SAME "the query is the whole lifecycle" design —
 * never a hidden butchr-side override of what the operator's own query says.
 * `GithubPr.merged` is exposed on every match purely for the agent's own use
 * (so it can read its own PR's merge state via its MCP tool) — it does not
 * gate this type's discovery/activation.
 *
 * Kept apart from the Jira rule type (./resource-type.ts) and from
 * `./github-issue-type.ts` on purpose: this type, the issue type, and the
 * Jira type share the generic loop, agent keys and rule schema, and nothing
 * else. A `github-pr` rule has no relationships of its own; its matches are
 * NOT shared via any `onMatches` hook the way `github-issue`'s feed
 * `jira-idea` rules — no rule kind hears `github-pr` matches today.
 *
 * Notifications carry identity and a reason, never GitHub-authored text:
 * titles, bodies and comments can be written by anyone who can open a pull
 * request, so an agent re-reads them itself rather than having them pushed
 * into its prompt.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { scopedPrQuery, type GithubComment, type GithubPr } from "../resources/github-pr.js";
import { parseGithubPrRef, type GithubPrRef } from "../resources/github-pr-ref.js";
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface GithubPrMatch {
  agentKey: string;
  rule: Rule;
  pr: GithubPr;
}

export interface GithubPrResourceDeps {
  /** Validated rules; only enabled `github-pr` rules are searched. */
  rules: readonly Rule[];
  /** Every pull request one rule query matches (already org-scoped by the client). */
  search: (query: string) => Promise<GithubPr[]>;
  /** Comments on one pull request, oldest first — used only to name the newest comment in a notification reason. */
  comments?: (ref: GithubPrRef) => Promise<readonly GithubComment[]>;
  /** True when a change to `resource` (now at `updated`) is `watcher`'s own write — e.g. its own comment — and not worth a nudge. */
  suppress?: (resource: string, updated: string, watcher: string) => boolean;
  log?: (line: string) => void;
  /** This provider's own running herd ids, for `logExecutionModeSwitches` — see `RuleResourceDeps.runningIds`'s own doc comment (src/rules/resource-type.ts). Optional; omitted, no mode-switch logging runs. */
  runningIds?: () => Promise<readonly string[]>;
}

/** True for exactly the herd ids this type owns — a per-resource key or a query-level one alike. */
export const ownsGithubPrAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "github-pr";

/** Every enabled `github-pr` rule's matches. Any failed search rejects the whole poll. */
export async function searchGithubPrRules(deps: Pick<GithubPrResourceDeps, "rules" | "search">): Promise<GithubPrMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "github-pr");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const seen = new Set<string>();
    const out: GithubPrMatch[] = [];
    for (const pr of await deps.search(rule.query)) {
      if (seen.has(pr.ref)) continue;
      seen.add(pr.ref);
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "github-pr", ruleId: rule.id, resourceId: pr.ref }), rule, pr });
    }
    return out;
  }));
  return perRule.flat();
}

export function specForGithubPr({ agentKey, rule, pr }: GithubPrMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: pr.ref,
    issuetype: "pr",
    summary: pr.title,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/**
 * A `singleton`/`persistent` rule's ONE query-level agent — no single
 * resource (`resource` is omitted, same "no single resource" contract
 * `SpawnSpec.resource`'s own doc comment states, and the same shape
 * `specForGithubIssueQuery` already uses), so no GitHub tool can be misled
 * into resolving it as a PR ref. `brief` is always the rule's own, same
 * reasoning as `specForGithubIssueQuery`.
 */
export function specForGithubPrQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every pull request "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

export const specForGithubPrUnit = (u: ExecutionUnit<GithubPrMatch>): SpawnSpec =>
  u.kind === "resource" ? specForGithubPr(u.match) : specForGithubPrQuery(u.rule, u.agentKey);

/** The fields whose change is worth telling an agent about. `updated` alone is not one of them. */
const observed = (m: GithubPrMatch) => JSON.stringify([m.pr.title, m.pr.body, m.pr.state, m.pr.merged, m.pr.draft, m.pr.labels, m.pr.comments]);

async function decideGithubPr(from: GithubPr, to: GithubPr, key: string, deps: Pick<GithubPrResourceDeps, "comments" | "suppress" | "log">): Promise<EventVerdict> {
  if (deps.suppress?.(to.ref, to.updated, key)) return { deliver: false };
  if (from.state !== to.state || from.merged !== to.merged) return { deliver: true, reason: { status: { from: from.merged ? "merged" : from.state, to: to.merged ? "merged" : to.state } } };
  if (to.comments > from.comments) return { deliver: true, reason: await newCommentReason(to, deps) };
  if (from.title !== to.title) return { deliver: true, reason: { summary: true } };
  return { deliver: true };
}

/** `{ comment: id }` when the newest comment can be read; otherwise says why it could not. */
async function newCommentReason(pr: GithubPr, deps: Pick<GithubPrResourceDeps, "comments" | "log">): Promise<NotifyReason> {
  const ref = parseGithubPrRef(pr.ref);
  if (!deps.comments || !ref) return { undetermined: "unchecked" };
  try {
    const id = (await deps.comments(ref)).at(-1)?.id;
    return id ? { comment: id } : { undetermined: "checked-unchanged" };
  } catch (e) {
    deps.log?.(`WARNING: [github-pr] comments for ${pr.ref} failed: ${(e as Error)?.message ?? e}`);
    return { undetermined: "check-failed" };
  }
}

/**
 * Change detection over (prev, next) matches, per agent key — the same
 * shape as `createGithubIssueEventRules`. Reason precedence: state/merge,
 * then a new comment (its id, when `comments` can name it), then title; any
 * other observed change delivers without a reason.
 *
 * PRIMARY covers only `"resource"`-kind units (swarm agents). RELATED covers
 * every `singleton`/`persistent` rule's own currently-matched PRs
 * (`scopeRelatedResources`), watcher = that rule's query agent key.
 */
export function createGithubPrEventRules(deps: Pick<GithubPrResourceDeps, "comments" | "suppress" | "log">): EventRules<ExecutionUnit<GithubPrMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<GithubPrMatch>>, next: PollSnapshot<ExecutionUnit<GithubPrMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), observed);
      const relatedOf = (related: readonly RelatedResource<ExecutionUnit<GithubPrMatch>>[]) =>
        related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: GithubPrMatch } => u.kind === "resource").map((u) => u.match);
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
            return decideGithubPr(pair.from.pr, pair.to.pr, key, deps);
          }
          const pair = relatedDiff.pairFor(key);
          const entry = relatedEntry(key);
          if (!pair || !entry?.watchers.includes(watcher)) return { deliver: false };
          return decideGithubPr(pair.from.pr, pair.to.pr, key, deps);
        },
      };
    },
  };
}

export function createGithubPrResourceType(deps: GithubPrResourceDeps): ResourceType<ExecutionUnit<GithubPrMatch>> {
  let latest: GithubPrMatch[] = [];
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchGithubPrRules(deps);
        if (deps.runningIds) logExecutionModeSwitches("github-pr", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "github-pr");
        return groupExecutionUnits(enabled, latest);
      },
      // Every `singleton`/`persistent` rule's own currently-matched PRs,
      // watched by that rule's query agent — `github-pr` has no other
      // related source (no Implements/Relates chain), so no merge is needed.
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createGithubPrEventRules(deps),
    spawnConfig: { specFor: specForGithubPrUnit },
  };
}

/**
 * Whether this daemon may run `github-pr` rules, decided once at startup.
 * Fails closed: without GitHub auth and org scope, or with any enabled rule
 * whose query cannot be scoped to those orgs, NO github-pr rule runs and
 * nothing is spawned for one — the reason says why, naming the same two
 * settings `githubIssueStaffing` names (both providers share one token/org
 * config — see `./github-pr.ts`'s own header). Jira rules are unaffected.
 */
export type GithubPrStaffing =
  | { run: true; rules: Rule[] }
  | { run: false; rules: Rule[]; reason: string | null };

export function githubPrStaffing(rules: readonly Rule[], github: { token: string; orgs: readonly string[] } | undefined): GithubPrStaffing {
  const enabled = rules.filter((r) => r.enabled && r.resourceProvider === "github-pr");
  if (!enabled.length) return { run: false, rules: [], reason: null };
  const ids = enabled.map((r) => r.id).join(", ");
  if (!github?.token || !github.orgs.length) return { run: false, rules: enabled, reason: `github-pr rules not staffed (${ids}): set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS` };
  const problems: string[] = [];
  for (const r of enabled) {
    try { scopedPrQuery(r.query, github.orgs); } catch (e) { problems.push(`${r.id}: ${(e as Error).message}`); }
  }
  if (problems.length) return { run: false, rules: enabled, reason: `github-pr rules not staffed (${ids}): ${problems.join("; ")}` };
  return { run: true, rules: enabled };
}
