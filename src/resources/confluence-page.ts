/**
 * FACTORY-997 (story FACTORY-994, epic FACTORY-348's "Gap 2"): the
 * event/wake path for a STANDALONE Confluence page — one with no owning
 * Jira ticket, so none of `src/jira-watch/*`'s ticket-bound machinery
 * (`pollConfluencePage`/`linked-eventing.ts`) ever runs for it; that path
 * only fires for a page reached through a Jira issue's own linked-item
 * list. This module is the OTHER half: a `ResourceType<ConfluencePageSnapshot>`
 * (see `src/resources/types.ts`) whose `eventRules.poll` tells a page's own
 * version bump apart from a new footer comment, so a page tracked with no
 * Jira ticket in sight can still wake its agent.
 *
 * SCOPE, deliberately narrow (per the ticket's own split): story FACTORY-992
 * (sibling, still SHELVED as of this writing — see that ticket) owns the
 * full provider — real discovery (`{ancestor: pageId}` child-page
 * enumeration via `AtlassianOps.getChildPages`), activation, and spawn
 * config tuned for a real Confluence-backed agent. `RESOURCE_PROVIDERS`
 * (`src/rules/agent-key.ts`) and `capabilities.ts`'s `query` cell for
 * `confluence-page` are UNTOUCHED here — registering this as a rule-staffed
 * provider the daemon runs in production is FACTORY-992's job, not this
 * one's; wiring this module's `ResourceType` into `src/daemon/index.ts`'s
 * production loop lineup before that discovery exists would just mean
 * discovering nothing. This file's own `discovery`/`activation`/
 * `spawnConfig` below exist ONLY so `ResourceType<ConfluencePageSnapshot>`
 * is complete enough to run through the real, unmodified `runResourceLoop`
 * (see `test/unit/confluence-page-resource-type.test.ts`'s integration
 * test, mirroring `test/unit/resource-type-second-instance.test.ts`'s own
 * proof technique) — they are a minimal seam, explicitly provisional, and
 * FACTORY-992's PR should replace them wholesale rather than build on them.
 *
 * THE PURE CORE, and the part that matters: `diffConfluencePage` below. No
 * network I/O, no Jira, nothing issue-shaped — just two
 * `ConfluencePageSnapshot`s (this poll's and last poll's, for the same page
 * id) in, one of {no change, edited, new comment(s)} out. Modelled on
 * `src/resources/project.ts`'s own version/comment-set diff (`changed`,
 * BUTCHR-227) rather than `src/resources/issue.ts`'s heavier suppression
 * stack — a standalone page has no daemon-label ledger, no "own write"
 * echo to guard against, so there is nothing here for a suppression arm to
 * suppress.
 */
import type { ActivationVerdict, EventPoll, EventVerdict, PollSnapshot, ResourceType } from "./types.js";
import type { SpawnSpec } from "../agents/workspace.js";

/**
 * This resource type's `T`: one standalone Confluence page, as observed by
 * ONE poll. `version` is exactly `confluencePageVersion`'s (`src/atlassian/
 * client.ts`) fingerprint — a page's own `version.number`, nothing content-
 * derived. `commentIds` is the FULL set of footer-comment ids `getPageComments`
 * (`src/tools/atlassian.ts`) returned this poll — never a single "newest"
 * id: per that op's own doc comment and this ticket's DoD, Confluence
 * comment ids are not guaranteed monotonic with creation time, so "newest"
 * is not a notion this module trusts. Compared by SET MEMBERSHIP only (see
 * `diffConfluencePage`), the same discipline `src/resources/project.ts`'s
 * `unseenIds`/`sameIdSet` already established for the project tier's own
 * Confluence-backed root-doc comments.
 */
export interface ConfluencePageSnapshot {
  readonly id: string;
  readonly title?: string;
  readonly version: number;
  readonly commentIds: readonly string[];
}

export const confluencePageIdOf = (p: ConfluencePageSnapshot): string => p.id;

/** One page's change, as `diffConfluencePage` found it — never both at once (see that function's own comment for why). */
export type ConfluencePageChange =
  | { kind: "edit"; from: number; to: number }
  | { kind: "comment"; newCommentIds: readonly string[] };

/**
 * The pure diff at the center of this module. `before === undefined` means
 * "this id was not present in the previous poll's snapshot at all" — the
 * FIRST time this module has ever observed this page, whether because the
 * daemon just started tracking it or because a transient read failure
 * dropped it from a prior poll's `next.primary` (see this module's
 * `search()` doc comment on how an unreadable page simply disappears from
 * a poll rather than carrying a null version). Per the ticket's own DoD
 * ("first observation establishes a baseline and does NOT wake, mirror
 * jira-work baseline semantics" — see `src/resources/issue.ts`'s
 * `commentCursor` seeding), that case returns `null`: a baseline, not a
 * change. There is deliberately no event for a page's own disappearance
 * either (also `null` — reached by this function never being called for an
 * id absent from `next`, see `createConfluencePageEventRules`'s `poll`): an
 * unreadable/deleted page should not storm the loop with a notify it has no
 * useful action to take on, and the ACTIVATION axis (FACTORY-992's
 * discovery, not this module) is the right place to decide whether an
 * agent for a page that stopped existing should be stopped, not this one's
 * event axis.
 *
 * VERSION CHECKED BEFORE COMMENTS, deliberately, when both moved in the
 * same poll: an edit is the more structural of the two (the page's own
 * content changed), mirroring the issue tier's own precedence (`decide()`,
 * `src/resources/issue.ts` — structural classifiers run before the §3D
 * comment fallback). A caller that cares about both happening in the same
 * poll still sees the comment movement on a LATER poll if the comment
 * arrived before this function last ran against it... no: once `version`
 * is reported, `after` becomes `before` for the next poll, so a comment
 * that arrived in the SAME poll as an edit is reported only as the edit —
 * documented here as a known, deliberate simplification, not an oversight:
 * recovering it would mean this function returning more than one
 * `ConfluencePageChange`, which `EventVerdict` (one `reason` per `decide()`
 * call) cannot carry anyway.
 */
export function diffConfluencePage(before: ConfluencePageSnapshot | undefined, after: ConfluencePageSnapshot): ConfluencePageChange | null {
  if (!before) return null;
  if (before.version !== after.version) {
    return { kind: "edit", from: before.version, to: after.version };
  }
  const beforeIds = new Set(before.commentIds);
  const newCommentIds = after.commentIds.filter((id) => !beforeIds.has(id));
  if (newCommentIds.length > 0) {
    return { kind: "comment", newCommentIds };
  }
  return null;
}

/**
 * `ResourceType<ConfluencePageSnapshot>.eventRules`, built purely from
 * `diffConfluencePage` above — no closure state, no I/O: everything this
 * needs arrives in `poll`'s own `(prev, next)` snapshots, matched by id.
 * `watcher` is always `key` here (a standalone page is only ever its own
 * watcher — no related-resource concept, unlike the issue tier's
 * Implements chain), so `space !== "primary"` never has a verdict to give.
 */
export function createConfluencePageEventRules() {
  return {
    async poll(prev: PollSnapshot<ConfluencePageSnapshot>, next: PollSnapshot<ConfluencePageSnapshot>): Promise<EventPoll> {
      const prevById = new Map(prev.primary.map((p) => [p.id, p] as const));
      const changedPrimary: string[] = [];
      const changes = new Map<string, ConfluencePageChange>();
      for (const page of next.primary) {
        const change = diffConfluencePage(prevById.get(page.id), page);
        if (change) {
          changedPrimary.push(page.id);
          changes.set(page.id, change);
        }
      }
      return {
        changedPrimary,
        changedRelated: [],
        async decide(key: string, _watcher: string, space: "primary" | "related"): Promise<EventVerdict> {
          if (space !== "primary") return { deliver: false };
          const change = changes.get(key);
          if (!change) return { deliver: false };
          if (change.kind === "edit") {
            return { deliver: true, reason: { confluencePageEdit: { from: change.from, to: change.to } } };
          }
          return { deliver: true, reason: { confluencePageComment: { ids: change.newCommentIds } } };
        },
      };
    },
  };
}

/**
 * Dependencies this module's own (provisional) `discovery` needs — the
 * minimal seam FACTORY-992's real discovery should replace, not build on
 * (see this module's top comment). `trackedPageIds` stands in for that
 * story's `{ancestor: pageId}` child-page enumeration (`getChildPages`);
 * here it is just "whatever pages are currently supposed to be watched",
 * injected rather than computed, so this module never has to guess at a
 * query shape that is not its own to design.
 */
export interface ConfluencePageDiscoveryDeps {
  trackedPageIds(): Promise<readonly string[]>;
  getPageVersions(pageIds: readonly string[]): Promise<Record<string, number>>;
  getPageComments(pageId: string): Promise<{ results: Array<{ id: string }> }>;
}

/**
 * The provisional `ResourceType<ConfluencePageSnapshot>` — see this
 * module's top comment for why `discovery`/`activation`/`spawnConfig` are
 * deliberately thin. `discovery.search()` fetches every tracked page's
 * version in ONE batched call (`getPageVersions`, same call this ticket's
 * findings point at — see that op's own doc comment on `AtlassianOps` for
 * the measured batching win), then one `getPageComments` call PER page
 * (never batched — that op's own doc comment names a MEASURED trap where a
 * batch-shaped footer-comments call silently returns the wrong pages'
 * comments). Call count per tick is therefore `1 + N` for `N` tracked
 * pages, documented in `docs/confluence-page-event-path.md`.
 *
 * A page `getPageVersions` has no entry for (deleted, or otherwise
 * unreadable this tick) is simply DROPPED from this poll's `search()`
 * result — never included with a null/sentinel version. This is what makes
 * "page deleted/inaccessible handled without crashing or storming" true
 * for the event axis (`diffConfluencePage` is never even called for it):
 * the id just stops appearing, and if it ever becomes readable again it is
 * treated as a first observation (a new baseline, no wake) rather than a
 * disappear-then-reappear pair of events. A single page's `getPageComments`
 * call throwing is handled the same way — caught and treated as this tick's
 * read failing for that page only, dropping just that id from this tick's
 * result, not the whole poll.
 */
export function createConfluencePageResourceType(deps: ConfluencePageDiscoveryDeps): ResourceType<ConfluencePageSnapshot> {
  return {
    discovery: {
      idOf: confluencePageIdOf,
      async search(): Promise<ConfluencePageSnapshot[]> {
        const ids = await deps.trackedPageIds();
        if (ids.length === 0) return [];
        const versions = await deps.getPageVersions(ids);
        const snapshots: ConfluencePageSnapshot[] = [];
        for (const id of ids) {
          const version = versions[id];
          if (typeof version !== "number") continue;
          let commentIds: readonly string[] = [];
          try {
            const comments = await deps.getPageComments(id);
            commentIds = comments.results.map((c) => c.id);
          } catch {
            continue;
          }
          snapshots.push({ id, version, commentIds });
        }
        return snapshots;
      },
    },
    // Provisional: every tracked page is "active" unconditionally — this
    // resource type has no notion of rest. FACTORY-992's real activation
    // (does the page still exist under its ancestor, does its agent still
    // belong) replaces this wholesale.
    activation: { verdictFor: (): ActivationVerdict => "active" },
    eventRules: createConfluencePageEventRules(),
    spawnConfig: {
      specFor: (p: ConfluencePageSnapshot): SpawnSpec => ({
        key: p.id,
        issuetype: "confluence-page",
        summary: p.title ?? p.id,
        parent: null,
      }),
    },
  };
}
