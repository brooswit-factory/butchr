/**
 * FACTORY-998 (story FACTORY-992, epic FACTORY-348): the rule engine's real
 * `ResourceType` for `confluence-page` rules — one item per (rule, CHILD
 * page of the rule's `{"ancestor": "<page id>"}` query) match, keyed
 * `confluence-page:<rule>:<child-page-id>`, active exactly while that child
 * page remains a direct child of the rule's ancestor.
 *
 * REPLACES WHOLESALE the provisional `discovery`/`activation`/`spawnConfig`
 * `src/resources/confluence-page.ts` built for FACTORY-997 (that module's
 * own top comment says explicitly this story should not build on them) —
 * this is a NEW module, not an edit to that one. What IS reused from that
 * module, deliberately: `diffConfluencePage` (the pure version/comment-set
 * diff) and the `ConfluencePageSnapshot`/`ConfluencePageChange` shapes —
 * there is no reason to reinvent "what changed about one page between two
 * polls" just because discovery now finds pages for real instead of taking
 * their ids as an injected dependency.
 *
 * Kept apart from every other provider's own `*-type.ts` the same way
 * `filesystem-type.ts`/`github-issue-type.ts` are kept apart from each
 * other and from the Jira rule type: it shares the generic loop, agent
 * keys, rule schema and execution-mode machinery (`./execution.ts`), and
 * nothing else. A `confluence-page` rule has no relationships of its own
 * (see `rules.ts`'s own relationships gate).
 *
 * BRIEF MECHANISM DECISION (ticket's design-decision #1, see
 * docs/confluence-page.md for the full writeup): `specFor` below sets
 * `brief: rule.brief` — the rule author's own fixed text — NEVER the child
 * page's own rendered content. This matches `filesystem`/`github-issue`/
 * every other provider's actual precedent (FACTORY-995's spike finding: no
 * provider inlines a resource's own content into the spawn brief), not the
 * epic gloss's looser phrasing. An agent that needs its own page's text
 * reads it via `get_my_confluence_page` (FACTORY-993/996,
 * src/tools/defs.ts) — a tool call, not a brief substitution — exactly the
 * tool that story was built to serve. This keeps the spawn path uniform
 * across every provider rather than special-casing this one.
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { diffConfluencePage, type ConfluencePageChange, type ConfluencePageSnapshot } from "../resources/confluence-page.js";
import { parseConfluencePageQuery } from "../resources/confluence-page-query.js";
import type { EventPoll, EventRules, EventVerdict, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface ConfluencePageMatch {
  agentKey: string;
  rule: Rule;
  page: ConfluencePageSnapshot;
}

/**
 * What this provider's own discovery needs from Atlassian — the real
 * surface, a strict subset of `AtlassianOps` (`src/tools/atlassian.ts`):
 * `getChildPages` (cursor-paginated direct-children read), `getPageVersions`
 * (batched version read) and `getPageComments` (per-page footer comments,
 * never batched — see that op's own doc comment for the measured trap a
 * batch-shaped call falls into). No new auth, no new credentials surface:
 * every real caller passes the SAME `AtlassianOps` instance every other
 * Confluence read path in this codebase already uses
 * (`src/daemon/index.ts`'s `ops`).
 */
export interface ConfluencePageResourceDeps {
  /** Validated rules; only enabled `confluence-page` rules are searched. */
  rules: readonly Rule[];
  getChildPages(parentId: string, cursor?: string): Promise<{ results: Array<{ id: string; title?: string }>; nextCursor?: string }>;
  getPageVersions(pageIds: readonly string[]): Promise<Record<string, number>>;
  getPageComments(pageId: string): Promise<{ results: Array<{ id: string }> }>;
  log?: (line: string) => void;
  /** BUTCHR-398: this provider's own running herd ids, for `logExecutionModeSwitches` — see `RuleResourceDeps.runningIds`'s own doc comment (src/rules/resource-type.ts). Optional; omitted, no mode-switch logging runs. */
  runningIds?: () => Promise<readonly string[]>;
}

/** True for exactly the herd ids this type owns — a per-resource key or a query-level one (BUTCHR-397) alike. */
export const ownsConfluencePageAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "confluence-page";

/**
 * `confluence-page`'s own short herdr-workspace-label id. A bare numeric
 * page id is already short and already the canonical resource id
 * (`ConfluencePageRef` — see `src/resources/confluence-page-ref.ts`), so
 * unlike `filesystem`'s own `filesystemShortDisplayId` (which must invent a
 * `parent:name` pair from a long path), nothing here needs shortening.
 */
export function confluencePageShortDisplayId(resourceId: string): string {
  return resourceId;
}

/**
 * Pagination safety cap, same role `MAX_RESULTS` plays for `filesystem`
 * (`src/resources/filesystem.ts`): bounds one rule's enumeration cost
 * independent of how many children an ancestor actually has, and — same
 * "a partial result must never read as a smaller true set" discipline —
 * crossing it rejects the WHOLE rule's poll rather than silently truncating
 * the child-page list (which would read as "those pages' agents stopped
 * existing").
 */
export const MAX_CHILD_PAGES = 5_000;

/**
 * Pages every cursor `getChildPages` hands back for one ancestor, to
 * exhaustion — the DoD's own pagination requirement. `cursor` continues a
 * prior page exactly per that op's own contract
 * (`src/tools/atlassian.ts#getChildPages`); the loop stops the moment a
 * page's `nextCursor` is `undefined`, never guessed or capped by a fixed
 * page count.
 */
async function listAllChildPages(
  deps: Pick<ConfluencePageResourceDeps, "getChildPages">,
  ancestor: string,
): Promise<Array<{ id: string; title?: string }>> {
  const out: Array<{ id: string; title?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await deps.getChildPages(ancestor, cursor);
    out.push(...page.results);
    if (out.length > MAX_CHILD_PAGES) {
      throw new Error(`confluence-page ancestor ${ancestor} has over ${MAX_CHILD_PAGES} child pages; narrow the rule or split it`);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Every enabled `confluence-page` rule's current child-page matches. ANY
 * failure (the ancestor's own `getChildPages` enumeration throwing, or the
 * pagination cap crossed) rejects the WHOLE poll — never a partial result —
 * same "a bad read is not a valid smaller result" discipline every other
 * provider's own `search*Rules` already has. A SINGLE child page's own
 * version-read miss (deleted, or otherwise unreadable this tick — absent
 * from `getPageVersions`' response) or `getPageComments` throw costs only
 * that one page, dropped from this tick's result, never the whole rule —
 * mirroring `src/resources/confluence-page.ts`'s own `discovery.search()`
 * failure behaviour exactly, now applied per (rule, child) instead of per
 * tracked page id.
 */
export async function searchConfluencePageRules(
  deps: Pick<ConfluencePageResourceDeps, "rules" | "getChildPages" | "getPageVersions" | "getPageComments">,
): Promise<ConfluencePageMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "confluence-page");
  const perRule = await Promise.all(
    enabled.map(async (rule): Promise<ConfluencePageMatch[]> => {
      const { ancestor } = parseConfluencePageQuery(rule.query);
      const children = await listAllChildPages(deps, ancestor);
      if (children.length === 0) return [];
      const ids = children.map((c) => c.id);
      const versions = await deps.getPageVersions(ids);
      const out: ConfluencePageMatch[] = [];
      for (const child of children) {
        const version = versions[child.id];
        if (typeof version !== "number") continue; // unreadable this tick — dropped, not a sentinel; see this module's own top comment.
        let commentIds: readonly string[] = [];
        try {
          const comments = await deps.getPageComments(child.id);
          commentIds = comments.results.map((c) => c.id);
        } catch {
          continue; // this one page's comments read failed this tick — drop just this page, not the whole rule.
        }
        out.push({
          agentKey: encodeAgentKey({ resourceProvider: "confluence-page", ruleId: rule.id, resourceId: child.id }),
          rule,
          page: { id: child.id, version, commentIds, ...(child.title !== undefined ? { title: child.title } : {}) },
        });
      }
      return out;
    }),
  );
  return perRule.flat();
}

export function specForConfluencePage({ agentKey, rule, page }: ConfluencePageMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: page.id,
    issuetype: "confluence-page",
    summary: page.title ?? page.id,
    parent: null,
    // See this module's own top comment ("BRIEF MECHANISM DECISION"): always
    // the rule's own fixed text, never the page's own rendered content.
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
    ...(rule.permissionMode ? { permissionMode: rule.permissionMode } : {}),
    ...(rule.lizardMode ? { lizardMode: true } : {}),
  };
}

/**
 * BUTCHR-398: the SpawnSpec for a `singleton`/`persistent` rule's ONE
 * query-level agent — no single resource (`resource` omitted), same "no
 * single resource" contract every other provider's own query-agent spec
 * already follows (`specForFilesystemQuery`, `specForGithubIssueQuery`).
 */
export function specForConfluencePageQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every child page of ancestor "${parseConfluencePageQuery(rule.query).ancestor}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
    ...(rule.permissionMode ? { permissionMode: rule.permissionMode } : {}),
    ...(rule.lizardMode ? { lizardMode: true } : {}),
  };
}

export const specForConfluencePageUnit = (u: ExecutionUnit<ConfluencePageMatch>): SpawnSpec =>
  u.kind === "resource" ? specForConfluencePage(u.match) : specForConfluencePageQuery(u.rule, u.agentKey);

/** `{ reason }` for one `ConfluencePageChange`, in `NotifyReason`'s own two-member confluence-page shape (`src/resources/types.ts`). */
function reasonForChange(change: ConfluencePageChange): EventVerdict {
  return change.kind === "edit"
    ? { deliver: true, reason: { confluencePageEdit: { from: change.from, to: change.to } } }
    : { deliver: true, reason: { confluencePageComment: { ids: change.newCommentIds } } };
}

const relatedUnitsOf = (related: readonly RelatedResource<ExecutionUnit<ConfluencePageMatch>>[]) =>
  related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: ConfluencePageMatch } => u.kind === "resource").map((u) => u.match);

/**
 * Change detection, built directly on `diffConfluencePage`
 * (`src/resources/confluence-page.ts`) — per the ticket's own instruction
 * to reuse that edit-vs-comment diff rather than reinvent a generic
 * fingerprint comparison the way `filesystem-type.ts`'s `observed()` does.
 *
 * PRIMARY (swarm agents): a child page entering or leaving a rule's result
 * is NOT itself a notification — the reconciler spawns/stops its agent, the
 * same "appear/disappear needs no dedicated event" discipline every other
 * simple provider already follows (and the one `confluence-page.ts`'s own
 * `search()` doc comment already states for a page that stops being
 * readable). Only a page that stayed matched across both polls and
 * genuinely changed (version bump, or a new footer comment — never both at
 * once, see `diffConfluencePage`'s own doc comment) is reported, keyed by
 * agent key so two different rules naming the same child page never
 * collide.
 *
 * RELATED (singleton/persistent rules' own scope, BUTCHR-398): the same
 * `diffConfluencePage` comparison, over the rule's currently-matched set —
 * PLUS `{appeared}`/`{disappeared}` for a page entering/leaving that scope,
 * the same "create/modify/remove delivered to singleton/persistent agents"
 * requirement `filesystem-type.ts`'s own `unionDiff`/`decideFromUnion`
 * implement; this differs from THAT PRIMARY path, which keeps appear/
 * disappear silent — a query agent's whole job is to know its scope's
 * membership, so it needs an explicit `{appeared}`/`{disappeared}` where a
 * swarm agent needs none (it simply starts or stops existing).
 */
export function createConfluencePageTypeEventRules(): EventRules<ExecutionUnit<ConfluencePageMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<ConfluencePageMatch>>, next: PollSnapshot<ExecutionUnit<ConfluencePageMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), (m) => JSON.stringify(m.page));
      const primaryChange = new Map<string, ConfluencePageChange>();
      for (const key of primaryDiff.changed) {
        const pair = primaryDiff.pairFor(key);
        if (!pair) continue;
        const change = diffConfluencePage(pair.from.page, pair.to.page);
        if (change) primaryChange.set(key, change);
      }
      const changedPrimary = [...primaryChange.keys()];

      const beforeRelated = new Map(relatedUnitsOf(prev.related).map((m) => [m.agentKey, m.page] as const));
      const afterRelatedList = relatedUnitsOf(next.related);
      const afterRelated = new Map(afterRelatedList.map((m) => [m.agentKey, m.page] as const));
      const relatedKeys = new Set([...beforeRelated.keys(), ...afterRelated.keys()]);
      const relatedChange = new Map<string, ConfluencePageChange | "appeared" | "disappeared">();
      for (const key of relatedKeys) {
        const before = beforeRelated.get(key);
        const after = afterRelated.get(key);
        if (!before && after) relatedChange.set(key, "appeared");
        else if (before && !after) relatedChange.set(key, "disappeared");
        else if (before && after) {
          const change = diffConfluencePage(before, after);
          if (change) relatedChange.set(key, change);
        }
      }
      const changedRelated = [...relatedChange.keys()];
      const relatedEntry = (key: string) => next.related.find((r) => unitAgentKey(r.issue) === key) ?? prev.related.find((r) => unitAgentKey(r.issue) === key);

      return {
        changedPrimary,
        changedRelated,
        async decide(key: string, watcher: string, space: "primary" | "related"): Promise<EventVerdict> {
          if (space === "primary") {
            if (watcher !== key) return { deliver: false };
            const change = primaryChange.get(key);
            return change ? reasonForChange(change) : { deliver: false };
          }
          const entry = relatedEntry(key);
          if (!entry?.watchers.includes(watcher)) return { deliver: false };
          const change = relatedChange.get(key);
          if (!change) return { deliver: false };
          if (change === "appeared") return { deliver: true, reason: { appeared: true } };
          if (change === "disappeared") return { deliver: true, reason: { disappeared: true } };
          return reasonForChange(change);
        },
      };
    },
  };
}

/**
 * ACTIVATION: every discovered child page is unconditionally `"active"` —
 * this provider has no notion of rest (same as `filesystem`/`github-issue`).
 * A child page REMOVED from the ancestor simply stops being returned by
 * `discovery.search()` on the next poll; the generic reconciler
 * (`runResourceLoop`, `src/daemon/loop.ts`) sees its agent key missing from
 * the desired set and stops it — no dedicated "disappeared" event is needed
 * on the primary/swarm path for this to work (verified against
 * `src/rules/resource-type.ts`'s/`runResourceLoop`'s own
 * running-minus-desired reconciliation, the same mechanism every other
 * swarm provider already relies on).
 */
export function createConfluencePageResourceType(deps: ConfluencePageResourceDeps): ResourceType<ExecutionUnit<ConfluencePageMatch>> {
  let latest: ConfluencePageMatch[] = [];
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchConfluencePageRules(deps);
        if (deps.runningIds) logExecutionModeSwitches("confluence-page", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "confluence-page");
        return groupExecutionUnits(enabled, latest);
      },
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createConfluencePageTypeEventRules(),
    spawnConfig: { specFor: specForConfluencePageUnit },
  };
}
