/**
 * The rule engine's `ResourceType` for `github-issue` rules: one item per
 * (rule, GitHub issue) match, keyed `github-issue:<rule>:<owner/repo#n>`,
 * active exactly while the rule's query returns the issue.
 *
 * Kept apart from the Jira rule type (./resource-type.ts) on purpose: the two
 * share the generic loop, agent keys and rule schema, and nothing else.
 * GitHub issues have no relationships here yet — no related set, no
 * cross-provider links.
 *
 * Notifications carry identity and a reason, never GitHub-authored text:
 * titles, bodies and comments can be written by anyone who can open an
 * issue, so an agent re-reads them itself rather than having them pushed
 * into its prompt.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { scopedIssueQuery, type GithubComment, type GithubIssue } from "../resources/github-issue.js";
import { parseGithubIssueRef, type GithubIssueRef } from "../resources/github-issue-ref.js";
import type { EventPoll, EventRules, EventVerdict, NotifyReason, PollSnapshot, ResourceType } from "../resources/types.js";
import { decodeAgentKey, encodeAgentKey } from "./agent-key.js";
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
}

/** True for exactly the herd ids this type owns. */
export const ownsGithubIssueAgent = (id: string): boolean => decodeAgentKey(id)?.resourceProvider === "github-issue";

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

/** The fields whose change is worth telling an agent about. `updated` alone is not one of them. */
const observed = (i: GithubIssue) => JSON.stringify([i.title, i.body, i.state, i.stateReason, i.issueType, i.labels, i.comments]);

/**
 * Change detection over (prev, next) matches, per agent key. An issue
 * entering or leaving a rule's query is not a notification — the reconciler
 * spawns or stops its agent. A change GitHub reports only through `updated`
 * (a reaction, a subscription) is not one either.
 *
 * Reason precedence: state, then a new comment (its id, when `comments` can
 * name it), then title; any other observed change delivers without a reason.
 */
export function createGithubIssueEventRules(deps: Pick<GithubIssueResourceDeps, "comments" | "suppress" | "log">): EventRules<GithubIssueMatch> {
  return {
    async poll(prev: PollSnapshot<GithubIssueMatch>, next: PollSnapshot<GithubIssueMatch>): Promise<EventPoll> {
      const before = new Map(prev.primary.map((m) => [m.agentKey, m.issue]));
      const pairs = new Map<string, { from: GithubIssue; to: GithubIssue }>();
      for (const m of next.primary) {
        const from = before.get(m.agentKey);
        if (from && observed(from) !== observed(m.issue)) pairs.set(m.agentKey, { from, to: m.issue });
      }
      return {
        changedPrimary: [...pairs.keys()],
        changedRelated: [],
        async decide(key, watcher, space): Promise<EventVerdict> {
          const pair = pairs.get(key);
          if (space !== "primary" || watcher !== key || !pair) return { deliver: false };
          const { from, to } = pair;
          if (deps.suppress?.(to.ref, to.updated, key)) return { deliver: false };
          if (from.state !== to.state) return { deliver: true, reason: { status: { from: from.state, to: to.state } } };
          if (to.comments > from.comments) return { deliver: true, reason: await newCommentReason(to) };
          if (from.title !== to.title) return { deliver: true, reason: { summary: true } };
          return { deliver: true };
        },
      };
      /** `{ comment: id }` when the newest comment can be read; otherwise says why it could not. */
      async function newCommentReason(issue: GithubIssue): Promise<NotifyReason> {
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
    },
  };
}

export function createGithubIssueResourceType(deps: GithubIssueResourceDeps): ResourceType<GithubIssueMatch> {
  return {
    discovery: { idOf: (m) => m.agentKey, search: () => searchGithubIssueRules(deps) },
    activation: { verdictFor: () => "active" },
    eventRules: createGithubIssueEventRules(deps),
    spawnConfig: { specFor: specForGithubIssue },
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
