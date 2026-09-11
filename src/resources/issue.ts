/**
 * The issue tier expressed as ONE instance of ResourceType<JiraIssue>
 * (BUTCHR-64/BUTCHR-69). Before this ticket, the four concerns below were
 * hardcoded and scattered across src/daemon/index.ts and src/daemon/loop.ts;
 * this module is where they now live, declared exactly once each:
 *
 * - DISCOVERY: `ISSUE_JQL` + `createRelated` (the Implements-chain walk).
 * - ACTIVATION: `ISSUE_ACTIVATION`, a thin wrapper over the SHARED
 *   `isActive`/`ACTIVE_STATUSES` in src/reconcile/plan.ts — that predicate
 *   also backs the label layer (src/labels/sync.ts, src/labels/plan.ts) and
 *   is deliberately NOT forked here; this module only re-exposes it through
 *   the interface.
 * - EVENT RULES: `createIssueEventRules` — the suppression stack
 *   (own-write ledger consultation, the cross-daemon label-only echo check,
 *   the DAEMON_WRITER ledger-hit comment-cursor discriminator, and the pr:*
 *   transition override) that used to live inside src/daemon/loop.ts's
 *   `onChange`. See its own doc comment for the incidents each piece guards
 *   against (KAN-793/799/804/814/819/823/828/838, BUTCHR-18/24).
 * - SPAWN CONFIG: `ISSUE_SPAWN_CONFIG` — produces the SpawnSpec the existing
 *   SHARED machinery (src/agents/workspace.ts's briefFor/modelFor/effortFor,
 *   src/agents/argv.ts, buildWorkspace) already consumes unchanged, keyed
 *   off `SpawnSpec.issuetype` exactly as today.
 */
import type { JiraIssue, JiraComment, IssueLink } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";
import { changedKeys, isDaemonLabelOnlyDiff, daemonLabelsChanged, daemonLabelTransition, prTransition } from "../jira-watch/diff.js";
import { watchedKeys } from "../jira-watch/routes.js";
import { agentFoldSuppressedLine, standDownSuppressedLine } from "../jira-watch/suppressed-log.js";
import type { StandDownRegistry } from "../agents/stand-down.js";
import type {
  Activation,
  EventPoll,
  EventRules,
  EventVerdict,
  PollSnapshot,
  RelatedResource,
  ResourceType,
  SpawnConfig,
} from "./types.js";

/**
 * The issue tier's DISCOVERY query — every issue this credential is actively
 * working. Used both by `createIssueResourceType`'s `discovery.search` below
 * and by src/daemon/index.ts's one-time startup credential check (so both
 * sites name the same query instead of two copies drifting apart).
 */
export const ISSUE_JQL = 'assignee = currentUser() AND status IN ("In Progress", "In Review") ORDER BY updated DESC';

/**
 * BUTCHR-240: a SEPARATE, narrower query, fed only to
 * `createAbandonedDetector`'s optional `todoWorkers` dep
 * (src/agents/abandoned.ts) — never folded into `ISSUE_JQL` above.
 * `ISSUE_JQL` is the fleet's ACTIVE SET: spawning, stall detection, the
 * label layer and reconcile all read the poll it drives, so adding `"To
 * Do"` there would staff an agent for every To Do ticket in the backlog, a
 * blast radius far past this one detector. This query exists so a To Do
 * worker whose `Implements` boss has already reached Done — invisible to
 * `ISSUE_JQL` and therefore to `parked.ts` and `abandoned.ts` alike, since
 * the orphan machinery also can't see it (its boss link is intact) — is
 * still audible. See `abandonedCandidates`'s own doc comment for why the
 * PREDICATE needed no change once this feeds it: it was already total over
 * a To Do worker with a Done inward Implements stub.
 *
 * BUTCHR-251: `ORDER BY created ASC, key ASC` is deliberate, and NOT a copy
 * of `ISSUE_JQL`'s `ORDER BY updated DESC` above — that would be the wrong
 * fix here. The defect this closes isn't a measured instability in Jira's
 * default ordering; it's that an ORDER BY-less query has NO ordering
 * contract at all, so `search()`'s `maxResults = 100` cap (src/atlassian/
 * client.ts) silently decides which rows come back on an unpromised
 * property (BUTCHR-195's defect class). `updated` is explicitly rejected as
 * the key: it mutates every time a ticket is touched, so under the same cap
 * the window's membership still shifts as tickets are edited — a
 * differently-unstable set, not a stable one. `ISSUE_JQL` gets away with
 * `updated` only because its population (In Progress/In Review) is bounded
 * by what the fleet can actually staff and cannot approach the cap; the To
 * Do backlog this query reads is bounded by nothing, so the same choice
 * would not be safe here. `created` is immutable per issue and orders
 * oldest-first, so under a cap the longest-stranded tickets are the ones
 * that stay visible — the right bias for an abandonment detector, though a
 * secondary nicety, not the justification. `key` is unique and immutable
 * and breaks any `created` tie, making the order total: without it, equal
 * `created` values would leave order unspecified again, the very thing
 * being fixed, in miniature.
 */
export const TODO_WORKER_JQL = 'assignee = currentUser() AND status = "To Do" ORDER BY created ASC, key ASC';

/**
 * Deliberate, commented (BUTCHR-69 criterion 3): distinguishes an ISSUE key
 * ("ABC-123") from a Jira PROJECT key ("ABC") for the Implements-chain
 * `related` walk below.
 *
 * Kept as its own, unexported, UNCHANGED copy — moved verbatim from the
 * module-local `KEY_RE` that used to live in src/daemon/index.ts — rather
 * than unified with the differently-shaped `JIRA_KEY_RE` exported from
 * src/tools/docs.ts (`/^[A-Z][A-Z0-9_]*-[0-9]+$/`, which additionally allows
 * an underscore in the prefix). The epic's ruling on this ticket: unifying
 * two divergent key regexes under cover of "just an interface refactor" is
 * itself a behaviour change on the `related` path unless the divergence is
 * first SHOWN unreachable — and nobody has shown that; a real key containing
 * an underscore has been judged unlikely, not ruled out. This ticket is not
 * the place to fix that inconsistency, only to not silently absorb it, so
 * this regex is left exactly as it always was.
 */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export const issueIdOf = (issue: JiraIssue): string => issue.key;

/**
 * ACTIVATION: delegates to the SHARED `isActive` (src/reconcile/plan.ts) —
 * see this module's top comment for why that predicate is not forked here.
 *
 * BUTCHR-66/83 held that issues do not sleep at all — "asleep" was
 * UNREACHABLE from this function, not merely unused, because `isActive`'s
 * boolean had nowhere else to go. BUTCHR-307 narrows that claim rather than
 * reversing it: `"asleep"` is still unreachable from STATUS ALONE (a
 * `stand_down`'d issue's Jira status never changes — it stays "In Progress"
 * the whole time, see that ticket's own design), but is now reachable
 * through `issue.asleep`, a SYNTHETIC field (src/atlassian/types.ts's own
 * doc comment) that only `createIssueResourceType`'s `discovery.search()`
 * below ever stamps, from the in-memory stand-down registry
 * (src/agents/stand-down.ts). This function itself stays a plain,
 * synchronous read of `T` either way — no registry consulted here, no
 * change to the pure/synchronous contract `runResourceLoop`'s two-pass
 * correctness argument depends on (src/daemon/loop.ts). See
 * test/unit/sleep.test.ts for both halves of the updated proof: status
 * alone still never produces `"asleep"`, and `issue.asleep` now does.
 */
export const ISSUE_ACTIVATION: Activation<JiraIssue> = {
  verdictFor: (issue) => (issue.asleep ? "asleep" : isActive(issue.status) ? "active" : "inactive"),
};

/**
 * BUTCHR-169: this fleet's boss/worker relationship is carried ENTIRELY by
 * an `Implements` issue link (src/tools/relationship.ts's assertOwnWorker
 * and friends) — NEVER by Jira's native `parent` field, which
 * `JiraIssue.parent`'s own doc comment (src/atlassian/types.ts) documents as
 * structurally unable to carry it in this project. `SpawnSpec.parent` (fed
 * into `{{PARENT}}`, src/agents/workspace.ts) used to read `issue.parent`
 * directly and was therefore EMPIRICALLY ALWAYS NULL for every ticket with a
 * real boss — a false-at-write-time claim, not merely one that could go
 * stale. Fixed at the source here, not by suppressing the assertion in the
 * templates: derives the boss from `issue.issuelinks` (populated by
 * `search()`, src/atlassian/client.ts, specifically so this needs no second
 * per-issue API call on every poll) the SAME WAY `findBossKey`
 * (src/tools/docs.ts) does for the raw-JSON shape `jira_get_issue` returns —
 * an inward `Implements` link names the boss. Two different wire shapes,
 * same convention, verified against the identical evidence `IssueLink`'s own
 * doc comment (src/atlassian/types.ts) cites; kept as two small functions
 * rather than one shared helper because the input shapes genuinely differ
 * (raw Jira JSON vs. this codebase's own flattened `IssueLink[]`), not
 * because the RULE differs.
 */
export function bossKeyFrom(issue: JiraIssue): string | null {
  return issue.issuelinks?.find((l) => l.type === "Implements" && l.otherEnd === "inward")?.key ?? null;
}

/** SPAWN CONFIG: the SpawnSpec fields the existing shared spawn machinery reads — see this module's top comment. */
export const ISSUE_SPAWN_CONFIG: SpawnConfig<JiraIssue> = {
  specFor: (issue) => ({ key: issue.key, issuetype: issue.issuetype, summary: issue.summary, parent: bossKeyFrom(issue) }),
};

export interface IssueResourceDeps {
  /** Raw Jira issue search (e.g. AtlassianClient#search), given a JQL string. */
  search: (jql: string) => Promise<JiraIssue[]>;
  /** An issue's links (e.g. AtlassianClient#links) — used only by `related`'s Implements-chain walk. */
  links: (key: string) => Promise<readonly IssueLink[]>;
  /**
   * Whether a ping to `watcher` about `key` (now at `updated`) should be
   * swallowed as an echo of a write THIS daemon made — see the own-write
   * ledger, src/jira-watch/own-writes.ts. Optional; omitted, nothing is ever
   * suppressed as a self-write echo.
   */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  /**
   * Recent comments on a ticket, newest first. Optional; omitted, none of
   * the cross-daemon/ledger-hit checks below ever suppress on it, and no
   * first-sighting baseline is ever seeded (see createIssueEventRules).
   */
  comments?: (key: string) => Promise<readonly JiraComment[]>;
  /**
   * BUTCHR-307: the issue tier's sleep/wake registry (src/agents/stand-down.ts)
   * — optional so every existing caller/test built before this ticket keeps
   * working unchanged (an issue tier with no `standDown` dep simply never
   * sleeps, exactly as before). When present, `discovery.search()` below
   * stamps `.asleep` onto each returned issue from `standDown.isAsleep`, and
   * `createIssueEventRules`'s `decide()` consults it to decide whether a
   * notify edge to a currently-asleep watcher is genuinely new (see that
   * module's own top comment for the self-wake hazard this exists to close).
   */
  standDown?: StandDownRegistry;
  /**
   * BUTCHR-350: where `createIssueEventRules`'s suppression stack writes its
   * `[notify-suppressed]` lines (src/jira-watch/suppressed-log.ts) — the
   * SUPPRESSION side of the notify record, `[notify]`'s own sibling.
   * Optional; the default, resolved at CALL time (a plain `console.error`
   * lookup inside the closure below, never a reference captured at import
   * time), picks up `installLogSink()`'s wrap automatically exactly like
   * every other `log:`/`deps.log` default in this codebase (see
   * src/daemon/log-sink.ts's own doc comment for why that matters — AC1).
   */
  log?: (line: string) => void;
}

/**
 * DISCOVERY.related: work related to the active set via the Implements chain
 * (see src/jira-watch/routes.ts) — a boss watches what implements it.
 * Watched regardless of assignee: the assigned-issues search is
 * per-credential, but a boss must hear about its implementer's progress even
 * when another account (another machine's daemon) staffs it.
 *
 * Moved verbatim from src/daemon/index.ts's `related` (BUTCHR-69) — a thin
 * I/O adapter over routes.ts: this function fetches links and hydrates
 * issues; routes.ts decides which links are routed.
 */
/**
 * BUTCHR-240: the `todoWorkers` fetch seam `createAbandonedDetector`
 * (src/agents/abandoned.ts) optionally takes — a single `deps.search(...)`
 * call, the same house pattern `createRelated` below uses for its own
 * batched extra query. Lives here, beside `TODO_WORKER_JQL`, rather than
 * inside `abandoned.ts` itself, so that module's dependency surface never
 * has to import a JQL string or know how a search is actually issued — it
 * only takes a `() => Promise<JiraIssue[]>` function.
 */
export function createTodoWorkersFetch(deps: Pick<IssueResourceDeps, "search">): () => Promise<JiraIssue[]> {
  return () => deps.search(TODO_WORKER_JQL);
}

function createRelated(deps: Pick<IssueResourceDeps, "search" | "links">) {
  return async (active: readonly string[]): Promise<RelatedResource<JiraIssue>[]> => {
    const keys = active.filter((k) => ISSUE_KEY_RE.test(k));
    if (!keys.length) return [];
    const out = new Map<string, { issue: JiraIssue; watchers: Set<string> }>();
    const add = (issue: JiraIssue, watcher: string) => {
      const e = out.get(issue.key) ?? { issue, watchers: new Set<string>() };
      e.issue = issue;
      e.watchers.add(watcher);
      out.set(issue.key, e);
    };
    const linkWatchers = new Map<string, Set<string>>();
    for (const k of keys)
      for (const other of watchedKeys(await deps.links(k))) {
        // Active ends are NOT skipped: a boss and its implementer can both be
        // staffed by this same daemon (same assignee credential), and the
        // boss must still hear its implementer's changes through this link.
        // The loop's `sent` dedupe (`${issue}|${about}`) already prevents the
        // implementer's own agent being notified twice about itself.
        if (!ISSUE_KEY_RE.test(other)) continue;
        (linkWatchers.get(other) ?? linkWatchers.set(other, new Set()).get(other)!).add(k);
      }
    const linked = [...linkWatchers.keys()];
    if (linked.length)
      for (const i of await deps.search(`key IN (${linked.join(",")})`))
        for (const w of linkWatchers.get(i.key) ?? []) add(i, w);
    return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers] }));
  };
}

/**
 * BUTCHR-87: a suppression arm's answer, widened from a bare `boolean` so a
 * "not suppressed" outcome can say WHY, when the arm already knows — see
 * crossDaemonSuppressed/ledgerHitSuppressed below, and `decide()`'s use of
 * `commentId`. `commentId` is only ever meaningful alongside
 * `suppressed: false`; a caller must not (and does not) read it otherwise.
 *
 * BUTCHR-350: `becauseComment: boolean` widened to `commentId?: string` —
 * the actual moved-to comment id, not just the fact that one moved. Every
 * existing producer/consumer only ever checked truthiness, so this was
 * MEANT to be additive: `commentId !== undefined` was meant to be exactly
 * the old `becauseComment === true`.
 *
 * BUTCHR-351 CORRECTION: that intent was not what the code did. On the one
 * edge a mover genuinely exists but has no id to report — the newest
 * comment id read back as `null`, because the ticket's comment list went
 * from non-empty to EMPTY (a deletion, not an addition) — `commentId` was
 * left OMITTED (`undefined`) instead of present-but-`null`. That made
 * `commentId !== undefined` false on a genuine mover — silently NOT the old
 * `becauseComment === true` on this one edge — so `decide()` fell through
 * to the general (status/label/summary) classifier below, which for a
 * daemon-label-only diff coinciding with this edge named a STRUCTURAL
 * `label` reason instead. That woke a sleeping watcher unconditionally,
 * where the pre-BUTCHR-350 code (and every other edge here) would have
 * gone through the non-structural `unseenFor` gate instead — a real
 * behaviour change BUTCHR-322's own §4 OUT forbids. Nothing exercised this
 * edge before, so nothing caught it (see test/unit/issue-standdown-loop.test.ts's
 * own BUTCHR-351 case, added to pin it).
 *
 * `commentId` is now typed `string | null`: `undefined` still means "this
 * arm did not determine a mover" (suppressed, or not reached — unchanged);
 * `null` means "a mover WAS positively determined, but it deleted the
 * ticket's newest comment rather than adding one, so there is no id to
 * report" — mirrors the pre-BUTCHR-350 `becauseComment: true` on this exact
 * edge, which never carried an id either. A caller recovers the old
 * `becauseComment === true` meaning by checking `commentId !== undefined`
 * (not truthiness, which `null` would silently fail) — see `decide()`'s own
 * use of it below.
 */
interface SuppressionVerdict {
  suppressed: boolean;
  commentId?: string | null;
}

/**
 * EVENT RULES: the issue tier's answer to "what changed, and what is worth
 * pushing". This is the suppression stack that used to live inside
 * src/daemon/loop.ts's `startLoop`/`onChange` — moved here verbatim (logic
 * and reasoning both), now exposed as `poll(prev, next)` per the epic's
 * opaque-snapshot ruling on BUTCHR-69: the loop hands this module a plain
 * (prev, next) pair of `{ primary, related }` issue arrays and asks what
 * changed, rather than diffing `JiraIssue` fields itself.
 */
export function createIssueEventRules(deps: Pick<IssueResourceDeps, "suppress" | "comments" | "standDown" | "log">): EventRules<JiraIssue> {
  // BUTCHR-350 AC1: every `[notify-suppressed]` line goes through this, and
  // only this — never a direct `process.stdout`/`process.stderr` write. The
  // default is a fresh closure that looks up `console.error` at CALL time
  // (a property read inside the arrow body, not a reference captured when
  // this line itself runs) — see IssueResourceDeps.log's own doc comment for
  // why that is what lets `installLogSink()`'s wrap apply automatically
  // regardless of construction order.
  const log = deps.log ?? ((line: string) => console.error(line));
  // Persists ACROSS polls (one instance per createIssueEventRules call, kept
  // alive for the resource type's lifetime — exactly as the old `commentCursor`
  // persisted for startLoop's lifetime): the last comment id observed per
  // key — for the cross-daemon label-echo check, the DAEMON_WRITER
  // ledger-hit check (KAN-828), and first-sighting baseline seeding
  // (KAN-828). Absence of a key means "no baseline yet" — the fail-safe case
  // that always delivers rather than suppresses on an unknown baseline;
  // seeding is what keeps a ledger hit from ever meeting that case.
  const commentCursor = new Map<string, string | null>();

  const issueOf = (list: readonly JiraIssue[], key: string) => list.find((i) => i.key === key);
  const relatedIssueOf = (list: readonly RelatedResource<JiraIssue>[], key: string) => list.find((r) => r.issue.key === key)?.issue;

  return {
    async poll(prev: PollSnapshot<JiraIssue>, next: PollSnapshot<JiraIssue>): Promise<EventPoll> {
      // BUTCHR-350 (§3D): a snapshot of `commentCursor` as it stood BEFORE
      // this poll touches it — a plain Map copy, no I/O, changes nothing
      // about this poll's own behaviour. Every suppression arm below
      // advances `commentCursor` itself as part of its OWN bookkeeping
      // (unchanged by this ticket), so by the time `decide()`'s own
      // no-structural-reason fallback runs, `commentCursor.get(key)` may
      // already read the NEW value — comparing against it there would be
      // tautological. This is the one fixed point `decide()` can honestly
      // compare a same-poll comments() result against to learn "did the
      // newest comment id move THIS poll", the fact §3(D)'s fix needs.
      const preCommentCursor = new Map(commentCursor);
      // ONE deps.comments(key) call per key, per poll — shared by baseline
      // seeding below, the DAEMON_WRITER ledger-hit comment-cursor check, and
      // the cross-daemon label-only echo check (KAN-828 item 4). Fails OPEN:
      // a rejected call (a transient network error — this is a live Jira
      // call), or `deps.comments` simply not being wired up, is never
      // treated as "no new comment" and never advances the cursor, so a
      // failed poll can never install a wrong baseline.
      // BUTCHR-307: widened from `{ok, newest}` to also carry `ids` — the
      // FULL comment id list this same call already fetched, reused by the
      // stand-down wake check below (`wakeIfAsleepAndUnseen`) instead of a
      // second `deps.comments(key)` call for the same key/poll. Every
      // existing consumer here only ever destructured `ok`/`newest`, so
      // adding a field changes nothing for them.
      const commentsCache = new Map<string, Promise<{ ok: true; newest: string | null; ids: readonly string[] } | { ok: false }>>();
      const fetchComments = (key: string): Promise<{ ok: true; newest: string | null; ids: readonly string[] } | { ok: false }> => {
        let p = commentsCache.get(key);
        if (!p) {
          p = (async () => {
            if (!deps.comments) return { ok: false as const };
            try {
              const comments = await deps.comments(key);
              return { ok: true as const, newest: comments[0]?.id ?? null, ids: comments.map((c) => c.id) };
            } catch {
              return { ok: false as const };
            }
          })();
          commentsCache.set(key, p);
        }
        return p;
      };

      // BASELINE SEEDING (KAN-828 item 3): every key sighted THIS poll with
      // no recorded comment-cursor entry yet gets one seeded now, from its
      // CURRENT newest comment id, so its first-ever ledger hit already has
      // a baseline to compare against — without this, the "unknown
      // baseline" fail-safe would turn every key's first daemon-label ledger
      // hit into a one-time echo nudge, noise this ticket must not add.
      // Fail-open: a rejected/unavailable call leaves the key unseeded,
      // retried on a later poll, never installing a baseline it did not
      // observe. A key that appears mid-run (a newly staffed ticket) is
      // seeded right here, on the poll it first appears — safe, because
      // `suppressed()` already delivers unconditionally on appear/disappear
      // (no `before`), and a ledger hit requires both `before` and `after`,
      // so by the time a key can ever hit the ledger it was necessarily
      // present — and thus seeded — on the previous poll. A ledger hit
      // therefore always has a baseline.
      const seenKeys = new Set<string>([...next.primary.map((i) => i.key), ...next.related.map((r) => r.issue.key)]);
      await Promise.all(
        [...seenKeys].map(async (key) => {
          if (commentCursor.has(key)) return;
          const result = await fetchComments(key);
          if (result.ok) commentCursor.set(key, result.newest);
        }),
      );

      // Memoized per key, per poll: the label-only branch makes at most one
      // comments() call per key, however many watchers consult it. Fails
      // OPEN: a rejected comments() call (a transient network error — this
      // is a live Jira call) must never suppress and must never write the
      // comment cursor, or a failed poll would install a wrong baseline and
      // could cause a LATER poll to wrongly suppress a real change.
      //
      // BUTCHR-87: return shape widened from `boolean` to `SuppressionVerdict`
      // — control flow and every suppress/don't-suppress OUTCOME below is
      // UNCHANGED; the only addition is `commentId`, set exactly when
      // this function already learned (from the comments() call it was
      // making anyway) that the newest comment id moved, which is also
      // exactly the one case where "not suppressed" here is caused BY a
      // comment rather than by a missing/unknown baseline. See `decide()`'s
      // use of it below — that field exists to NAME the delivery, not to
      // change whether one happens.
      //
      // BUTCHR-350 (§3A, arm 3): when this DOES suppress (`newest ===
      // baseline`, the cross-daemon label-only echo), NO `[notify-suppressed]`
      // line is written — deliberately, by this ticket's own volume
      // measurement (see suppressed-log.ts's top comment): this arm fires on
      // the order of a hundred times/hour on this fleet alone, every one of
      // them a routine agent:*/pr:* echo, not a lost message. A MISSING
      // `[notify-suppressed] arm=... ` line for a poll where this arm ran
      // means exactly one of: this echo (arm 3, omitted by design), the
      // sibling DAEMON-arm echo (arm 2, `ledgerHitSuppressed` below, also
      // omitted), or a genuine delivery (check for the matching `[notify]`
      // line) — never a claim that nothing happened.
      const crossDaemonCache = new Map<string, Promise<SuppressionVerdict>>();
      const crossDaemonSuppressed = (key: string, before: JiraIssue, after: JiraIssue): Promise<SuppressionVerdict> => {
        let p = crossDaemonCache.get(key);
        if (!p) {
          p = (async () => {
            if (!isDaemonLabelOnlyDiff(before, after)) return { suppressed: false };
            const result = await fetchComments(key);
            if (!result.ok) return { suppressed: false }; // cannot look -> do not suppress; cursor left untouched
            const hadBaseline = commentCursor.has(key);
            const baseline = commentCursor.get(key) ?? null;
            commentCursor.set(key, result.newest);
            if (!hadBaseline) return { suppressed: false }; // unknown baseline: never suppress
            if (result.newest === baseline) return { suppressed: true }; // arm 3 echo — no line, see above
            // A mover is now established (`result.newest !== baseline`,
            // both checks above already ruled out). `result.newest` is only
            // ever `null` here if the ticket's comment list went from
            // non-empty to empty (a deletion, not an addition) — reported
            // as `commentId: null` (BUTCHR-351), never omitted: omitting it
            // is exactly what made `decide()` misclassify this edge as
            // structural — see SuppressionVerdict's own doc comment.
            return { suppressed: false, commentId: result.newest };
          })();
          crossDaemonCache.set(key, p);
        }
        return p;
      };

      // DAEMON_WRITER ledger-hit comment-cursor check (KAN-828). The
      // own-write ledger's exact-`updated`-match discriminator
      // (own-writes.ts, not modified here) treats a foreign write folded
      // into our read-back the same as a pure self-write, which swallows a
      // reviewer/boss/human comment landing in that round-trip
      // (KAN-793/799/804). That guarantee is corrected HERE, not in
      // own-writes.ts (out of scope): a DAEMON_WRITER hit is no longer the
      // final verdict — it means "our write bumped `updated` — was anything
      // else folded in?", answered by whether the ticket's newest comment id
      // moved since the recorded baseline.
      //
      // `daemonLabelsChanged` decides WHICH arm to run, not what the cursor
      // means (KAN-838 — a prior version of this comment claimed a moved
      // newest-comment-id on the DAEMON arm meant something foreign was
      // folded in, treating that as proof the cursor could only be checked,
      // never advanced, on the AGENT arm; that reasoning was false). The
      // cursor's real invariant is "the newest comment id this daemon has
      // OBSERVED for this key", not "the newest it has DELIVERED" — every
      // path that learns the newest id must advance it, including a
      // suppression. The AGENT arm (an agent's own write, typically its own
      // comment, changing no daemon label) still always suppresses — that
      // part of KAN-828's reasoning holds — but it must ALSO resolve and
      // record the newest comment id before returning, via the same
      // per-poll `fetchComments` memo the DAEMON arm uses, so a stale
      // baseline never survives past the write that actually moved it.
      // Skipping that step is exactly what caused the regression this
      // ticket fixes: the NEXT daemon label write (agent:working<->idle,
      // every turn) would see the agent's own already-suppressed comment as
      // "new" and wake the agent about it. Fail-open discipline is
      // unchanged either way: a rejected/unwired fetch leaves the cursor
      // untouched, never installing a baseline nothing this poll observed.
      //
      // Two residuals, carried forward rather than silently dropped (KAN-828
      // documented the first; this ticket must not let the rewrite lose it):
      //
      // Known residual, stated rather than hidden: a ledger hit whose
      // folded-in foreign event was a status change with NO comment is still
      // suppressed — outside this discriminator's reach, on the DAEMON arm,
      // unchanged since KAN-828.
      //
      // Second known residual (KAN-838). BUTCHR-350(C) CORRECTS this
      // comment's own prior claim: a foreign comment landing in the SAME
      // fetch window as the agent's own write, folded into the cursor
      // advance below, is not merely withheld "that poll" — it is NEVER
      // delivered to the ticket's own agent, full stop. Verified at this
      // commit (test/unit/loop.test.ts's KAN-838 suite, case (g), and this
      // ticket's own suppressed-log tests): the fold ALSO advances
      // `commentCursor` to the true newest id in the same step, so on every
      // later poll, whatever arm next consults this key's cursor (almost
      // always crossDaemonSuppressed, via the next routine agent:* flip)
      // compares against a baseline that ALREADY includes the folded-in
      // comment — finds no further movement — and suppresses again. There
      // is no later poll at which the comparison could still be "new". The
      // message still reaches any WATCHER via crossDaemonSuppressed (which
      // never consults this cursor for a pure comment diff, so it is
      // unaffected by the fold) — this residual is specific to the ticket's
      // OWN agent. Re-delivering it is BUTCHR-321's job, not this ticket's
      // (§4 OUT) — this ticket only makes the loss VISIBLE (§3B below).
      //
      // BUTCHR-87: same return-shape widening as crossDaemonSuppressed above
      // (see its comment) — `commentId` is set on exactly the branch whose
      // own comment text already said "newest comment moved -> deliver".
      //
      // BUTCHR-350 (§3B, arm 1 — THE LOSSY ARM): the AGENT-writer branch
      // ALWAYS suppresses, unconditionally, exactly as before — nothing
      // about WHAT is suppressed changes here (§4 OUT). What's new is
      // comparing the just-fetched id list against the baseline it is
      // about to overwrite, BEFORE overwriting it, so a genuine fold can be
      // told apart from the ordinary case (the agent's own new comment
      // being the only thing that moved). A NAIVE "did newest change since
      // baseline" comparison cannot do this: the agent's own write is
      // ITSELF a comment far more often than not (this arm's own doc
      // comment: "typically its own comment"), so `newest !== baseline`
      // is true on nearly EVERY hit — logging on that alone would mean
      // logging nearly every own-write ledger hit, defeating the whole
      // point of choosing this as the LOW-volume arm to always log.
      // Instead: `result.ids` (already fetched, no second call) is newest
      // first; the recorded baseline's OWN position in that list says how
      // many comments are newer than it. Position 1 (baseline is the
      // second-newest) is consistent with "only the agent's one new
      // comment landed" — not logged, the ordinary case. Position 2 or
      // deeper means AT LEAST TWO comments are newer than the baseline in
      // one window; the agent wrote at most one of them, so at least one
      // more is foreign and was just folded into this suppression and lost
      // — logged, loud, every time (`agentFoldSuppressedLine`,
      // src/jira-watch/suppressed-log.ts). STATED LIMIT, not claimed away:
      // if the agent's OWN write this round-trip was NOT itself a comment
      // (e.g. a bare status transition) and exactly one foreign comment
      // landed in the same window, the position is 1 — indistinguishable,
      // by this signal alone, from the ordinary case, and is NOT logged.
      // This heuristic therefore UNDER-reports folds in that specific
      // narrower race; it never OVER-reports one (position >= 2 is only
      // ever reachable when more than one comment is genuinely newer than
      // the recorded baseline). Baseline not found in `result.ids` at all
      // (more comments landed than the fetch's own page size — see
      // AtlassianClient.comments's cap) is the same "cannot positively
      // establish a fold" case and is also not logged, for the same reason.
      const ledgerHitCache = new Map<string, Promise<SuppressionVerdict>>();
      const ledgerHitSuppressed = (key: string, before: JiraIssue, after: JiraIssue): Promise<SuppressionVerdict> => {
        let p = ledgerHitCache.get(key);
        if (!p) {
          p = (async () => {
            if (!daemonLabelsChanged(before, after)) {
              // Agent-writer arm / pure comment path: always suppressed, but
              // the cursor must still learn the newest id it just observed
              // (KAN-838) — see the block comment above.
              const result = await fetchComments(key);
              if (result.ok) {
                const hadBaseline = commentCursor.has(key);
                const oldBaseline = commentCursor.get(key) ?? null;
                commentCursor.set(key, result.newest);
                if (hadBaseline && oldBaseline !== null) {
                  const idx = result.ids.indexOf(oldBaseline);
                  if (idx >= 2 && result.newest !== null) {
                    log(agentFoldSuppressedLine(key, oldBaseline, result.newest, idx));
                  }
                }
              }
              return { suppressed: true };
            }
            const result = await fetchComments(key);
            if (!result.ok) return { suppressed: false }; // fail open: deliver, cursor untouched
            const baseline = commentCursor.get(key) ?? null;
            if (result.newest === baseline) return { suppressed: true }; // arm 2 echo — no line, see crossDaemonSuppressed's own comment on why
            commentCursor.set(key, result.newest);
            // See crossDaemonSuppressed's own comment for why `result.newest`
            // being `null` here (a deletion, not an addition) is reported as
            // `commentId: null`, never omitted (BUTCHR-351).
            return { suppressed: false, commentId: result.newest }; // newest comment moved -> deliver
          })();
          ledgerHitCache.set(key, p);
        }
        return p;
      };

      // Both suppression checks require an ACTUAL before/after pair — a key
      // appearing or disappearing is still a real change (the old
      // isOwnLabelBump made this explicit; crossDaemonSuppressed already
      // required both before this ticket too). `decide()` below now handles
      // appear/disappear itself, BEFORE ever calling this, for the same
      // reason: consulting the ledger with a stale previous `updated` for a
      // now-gone key would check a value nothing this poll actually
      // observed, so appear/disappear must always deliver, unchecked — that
      // rule hasn't moved, only which function states it has.
      const suppressed = async (key: string, before: JiraIssue, after: JiraIssue, watcher: string): Promise<SuppressionVerdict> => {
        if (deps.suppress?.(key, after.updated, watcher)) return ledgerHitSuppressed(key, before, after);
        return crossDaemonSuppressed(key, before, after);
      };

      // BUTCHR-307 — THE STAND-DOWN GATE. Every `decide()` return below that
      // means "deliver" is routed through here instead of returned directly,
      // so there is exactly ONE place that can turn a computed "deliver"
      // into an actual wake for a sleeping watcher — see
      // src/agents/stand-down.ts's own top comment for why a second,
      // drifting definition of "this agent needs to hear about this" is
      // exactly the failure this ticket must not introduce.
      //
      // A watcher that is not currently asleep (the overwhelmingly common
      // case — every existing caller/test with no `standDown` dep wired,
      // and every awake issue even when one is) is untouched: `verdict` is
      // returned exactly as computed, unchanged from before this ticket.
      //
      // For a SLEEPING watcher, the split is between a STRUCTURAL reason
      // (appeared/disappeared/status/label/pr/summary) and everything else
      // (no `reason` at all — the ordinary "a new comment landed" case — or
      // `{ comment: true }` — the daemon-label-race case). A structural
      // reason always wakes unconditionally: none of `stand_down`'s own
      // last-act writes (report_to_boss/tell_worker, both plain comments)
      // can ever PRODUCE a status/label/pr/summary change, so there is
      // nothing for a self-wake hazard to hide inside there. The other two
      // reason shapes are exactly the ones a self-authored comment CAN
      // produce (see this module's own decide() comments above on why a
      // pure comment diff falls through to the honest "no reason"
      // fallback), so those are compared against `watcher`'s recorded
      // seen-comment-ids for `key` by SET MEMBERSHIP (BUTCHR-227's rule,
      // reused via `unseenIds` — see stand-down.ts) before being allowed to
      // wake anything. A watcher with NO recorded baseline for `key` (e.g.
      // a worker created after `watcher` stood down — `hasBaseline` false)
      // fails TOWARD waking rather than silently swallowing a ticket the
      // stand-down snapshot never covered.
      //
      // APPEARED/DISAPPEARED IS STRUCTURAL FOR A DIFFERENT REASON THAN THE
      // OTHER FOUR, AND IT MATTERS (PR #322 review round 1): status/label/
      // pr/summary are safe here because stand_down's own writes cannot
      // produce them. `appeared`/`disappeared` is safe ONLY because
      // `runResourceLoop`'s own related-ticket fetch (src/daemon/loop.ts)
      // is fed `desired.keys()` UNIONED WITH `atRest` — an asleep watcher's
      // own related chain keeps being walked, so a sleeping watcher's
      // worker never spuriously vanishes from the snapshot purely because
      // the watcher itself went to sleep. Get that union wrong (as this
      // ticket's own PR did on its first head) and appeared/disappeared
      // stops being structural in the sense this gate needs — it becomes a
      // FEED-MEMBERSHIP ARTEFACT of the watcher's own sleep state, which is
      // exactly the class of input `stand-down.ts`'s own top comment now
      // names as forbidden. This gate has no way to detect that on its own;
      // it trusts its caller (`runResourceLoop`) to hand it a `related`
      // snapshot that only ever reflects Jira, never the loop's own
      // bookkeeping — see that fix's own comment for the measurement.
      const finalize = async (key: string, watcher: string, verdict: EventVerdict): Promise<EventVerdict> => {
        if (!verdict.deliver) return verdict;
        const sd = deps.standDown;
        if (!sd?.isAsleep(watcher)) return verdict;
        // BUTCHR-350: `decide()` no longer ever hands this a bare `{ deliver:
        // true }` with no `reason` for the ambiguous "maybe a comment"
        // fallback — it now always carries `{ undetermined: ... }` there
        // (see NotifyReason's own doc comment). That fallback is EXACTLY the
        // shape stand_down's own last-act writes (a plain comment) CAN
        // produce, same as `{ comment: ... }` already was — so it must stay
        // grouped with `comment`, non-structural, gated by the seen-set
        // check below, not promoted to `structural` merely because `Boolean(
        // verdict.reason)` is now true where it used to be false. Getting
        // this wrong would reopen the exact self-wake hazard stand-down.ts's
        // own top comment names: an agent's own comment, landing while it is
        // asleep, waking it unconditionally instead of being checked against
        // its own seen-set.
        const structural = Boolean(verdict.reason) && !("comment" in verdict.reason!) && !("undetermined" in verdict.reason!);
        if (structural) {
          await sd.wake(watcher, "edge");
          return verdict;
        }
        if (!sd.hasBaseline(watcher, key)) {
          await sd.wake(watcher, "edge");
          return verdict;
        }
        // FAIL TOWARD WAKING, never toward silently staying asleep: a
        // rejected comments() call here means "cannot verify whether this
        // is genuinely new", not "verified nothing new" — the same
        // fail-open discipline `crossDaemonSuppressed`/`ledgerHitSuppressed`
        // above already apply to their own comments() calls. Collapsing an
        // unreadable fetch into "nothing unseen" would be exactly the
        // silent-lost-wake failure mode this ticket's own doc names as
        // strictly worse than the defect it fixes.
        const result = await fetchComments(key);
        if (!result.ok) {
          await sd.wake(watcher, "edge");
          return verdict;
        }
        const unseen = sd.unseenFor(watcher, key, result.ids);
        // BUTCHR-350 (§3A, arm 4): a genuine suppression of an OBSERVED
        // change — this poll's own classifier already decided `deliver:
        // true` before this gate downgraded it — not an echo (see this
        // module's own top-of-file suppression-stack comment and
        // suppressed-log.ts's top comment for why this arm is logged
        // unconditionally, unlike arms 2/3: it is bounded by how many
        // watchers are CURRENTLY ASLEEP at all, a small, deliberately
        // stood-down population, nowhere near arms 2/3's routine-echo
        // volume). NUMERIC BOUND (BUTCHR-351, from existing figures, no new
        // measurement): the issue tier polls every `intervalMs: 15_000`
        // (src/daemon/index.ts) and `standDownMaxSleepMinutes` defaults to
        // 60 (src/config/config.ts) — a sleep episode is at most 240 polls,
        // so a single asleep watcher contributes at most 240
        // `arm=stand-down` lines PER KEY IT WATCHES for the whole time it
        // stays asleep, a ceiling only reached if every single poll in that
        // window produced a qualifying nothing-unseen suppression on that
        // key, not an observed rate.
        if (unseen.length === 0) {
          log(standDownSuppressedLine(key, watcher, result.ids.length));
          return { deliver: false };
        }
        await sd.wake(watcher, "edge");
        return verdict;
      };

      return {
        changedPrimary: changedKeys(prev.primary, next.primary),
        changedRelated: changedKeys(prev.related.map((r) => r.issue), next.related.map((r) => r.issue)),
        async decide(key: string, watcher: string, space: "primary" | "related"): Promise<EventVerdict> {
          const before = space === "primary" ? issueOf(prev.primary, key) : relatedIssueOf(prev.related, key);
          const after = space === "primary" ? issueOf(next.primary, key) : relatedIssueOf(next.related, key);
          // A pr:* transition on the ticket's OWN agent is delivered BEFORE
          // either suppression is consulted (KAN-691/KAN-819/KAN-823):
          // neither the own-write ledger (writer "daemon" — a label sync
          // write) nor isDaemonLabelOnlyDiff may swallow it, because it's
          // the one label flip an approved/changes-requested author is
          // actually waiting on. This only ever applies on the PRIMARY
          // (self) path — a related watcher never gets a pr:* reason, same
          // as before this refactor. This deliberately SKIPS
          // crossDaemonSuppressed too, so the per-key comment cursor does
          // not advance this poll for this key when no watcher also touches
          // it. That is safe: the cursor is compared for EQUALITY (see
          // crossDaemonSuppressed above) against `comments[0]?.id` from a
          // reader that explicitly requests `orderBy: "-created"`
          // (AtlassianClient.comments(), src/atlassian/client.ts — the
          // reader that actually feeds this cursor; see
          // AtlassianOps.getIssueComments's doc comment for the sibling
          // reader used elsewhere with the same guarantee) — so leaving it
          // one poll stale only ever biases a LATER comparison toward "not
          // suppressed" (delivered) — it can never manufacture a match that
          // wrongly suppresses a genuine later change.
          //
          // CORRECTED (BUTCHR-198/BUTCHR-202): this comment used to
          // attribute that safety to the cursor tracking "a
          // monotonically-growing newest-comment id". That misattributed
          // it: the safety above rests on two things that actually hold —
          // ids being DISTINCT (so a stale baseline cannot equal a newer,
          // different id) and `comments[0]` genuinely being newest because
          // the call explicitly REQUESTS `-created` order — not on
          // monotonic growth, which is sufficient but was never necessary
          // for this argument. Whether Jira issue-comment ids are in fact
          // monotonic with creation time is UNMEASURED here (unlike
          // Confluence footer-comment ids, measured twice independently to
          // be NOT monotonic) — this comment no longer needs that premise
          // and does not assume it. This mirrors the existing tolerance in
          // `suppressed()` itself: an own-write-ledger hit already
          // short-circuits before crossDaemonSuppressed ever runs.
          // BUTCHR-87: this is also why the pr:* reason keeps its own
          // NotifyReason member instead of folding into the general `label`
          // one below — `daemonLabelTransition` is a PURE function of
          // (before, after) with no notion of "self path" or "is this a
          // transition vs. a removal", so routing pr:* through it here
          // would silently change WHICH pr:* diffs this exemption covers
          // (prTransition deliberately excludes a pure pr:x -> no-pr:*
          // removal; daemonLabelTransition deliberately does not).
          if (space === "primary" && watcher === key) {
            const transition = before && after ? prTransition(before, after) : null;
            if (transition) return finalize(key, watcher, { deliver: true, reason: { pr: transition } });
          }
          // Appear/disappear (no `before` or no `after` to diff at all) is
          // still a real change and is still always delivered, unchecked —
          // unchanged from before this ticket (see `suppressed`'s own
          // comment above) — now also NAMED, since the poll can establish it
          // outright: there is nothing to look up, only a key's presence on
          // either side of the snapshot pair.
          if (!before) return finalize(key, watcher, { deliver: true, reason: { appeared: true } });
          if (!after) return finalize(key, watcher, { deliver: true, reason: { disappeared: true } });
          const verdict = await suppressed(key, before, after, watcher);
          if (verdict.suppressed) return { deliver: false };
          // BUTCHR-87: a delivery that escaped suppression BECAUSE the
          // suppression stack's own comment-cursor check observed the
          // newest comment id move (see crossDaemonSuppressed/
          // ledgerHitSuppressed above) is named as a comment — that is the
          // literal, established reason THIS delivery is happening: absent
          // the comment, the label-only diff underneath it would have been
          // swallowed. Checked before the structural classifier below on
          // purpose, so the label change that would otherwise have been
          // suppressed never shadows the actual cause of delivery.
          // BUTCHR-350: `commentId` (was `becauseComment: boolean`) carries
          // the actual moved-to id now — see NotifyReason's own doc comment
          // for why (journal correlation across the §3D duplicate pair).
          // BUTCHR-351: was a truthiness check, which silently treated
          // `commentId: null` (a genuine mover — the comment-DELETION edge,
          // see SuppressionVerdict's own doc comment) the same as
          // `commentId: undefined` (no mover at all), falling through to
          // the general classifier below and letting it name a STRUCTURAL
          // reason for what should stay non-structural. `!== undefined`
          // recovers the old `becauseComment === true` meaning on both the
          // with-id and no-id-because-deleted cases.
          if (verdict.commentId !== undefined) return finalize(key, watcher, { deliver: true, reason: { comment: verdict.commentId } });
          // The general classifier: every remaining diff the poll can name
          // from the (before, after) `JiraIssue` pair alone, no I/O. Order
          // is a deliberate, documented precedence (more than one can be
          // true of a single diff) — status first (the single highest-value
          // fact a boss can learn about a ticket), daemon label second (the
          // most COMMON class in the fleet, named zero times before this
          // ticket — see daemonLabelTransition for the pr:*-over-agent:*
          // tie-break when both changed), summary third. A diff naming none
          // of these (every visible field identical but `updated` itself —
          // a comment this poll never learned about, a link, or a field
          // JiraIssue does not carry at all) falls through to §3(D)'s
          // fallback below.
          if (before.status !== after.status) return finalize(key, watcher, { deliver: true, reason: { status: { from: before.status, to: after.status } } });
          const labelTransition = daemonLabelTransition(before, after);
          if (labelTransition) return finalize(key, watcher, { deliver: true, reason: { label: labelTransition } });
          if (before.summary !== after.summary) return finalize(key, watcher, { deliver: true, reason: { summary: true } });
          // BUTCHR-350 (§3D): the honest "looked, could not (from the
          // taxonomy above) tell" fallback — REPLACES the old bare `{
          // deliver: true }` (no `reason` at all). Confirmed at this commit
          // (the epic's own hypothesis in the ticket, and its own follow-up
          // comment's structural-constraint finding): a `{ comment: ... }`
          // reason is reachable ONLY via `verdict.commentId` above, which is
          // reachable ONLY through crossDaemonSuppressed/ledgerHitSuppressed,
          // both gated on a daemon-label change being present in THIS
          // poll's OWN (before, after) diff. A pure foreign-comment bump
          // (nothing else changed) never reaches that gate, so its FIRST
          // delivery always fell through to here with no way to name a
          // comment — not a race, structural, exactly as hypothesised.
          //
          // Do NOT change delivery here (§3D's own explicit constraint) —
          // every branch below still returns `deliver: true`, unconditionally,
          // exactly as the old bare fallback did. What's added is READING
          // (never fetching new) already-available per-poll comments()
          // state to give the REASON three honest, distinguishable shapes
          // instead of one collapsed "not determinable":
          //   - `commentsCache` (this poll's shared fetchComments memo) has
          //     NO entry for `key` at all: no arm had an I/O reason to check
          //     comments for this key this poll — "unchecked", the common
          //     case, and the literal mechanism behind §3D's duplicate-notify
          //     pair (this delivery, then a LATER poll whose daemon-label
          //     flip finally triggers the check and names `comment`).
          //   - an entry exists but its fetch failed: "check-failed" — a
          //     real, different fact from "unchecked" (reuses this
          //     codebase's existing "could not check" vocabulary — §4 OUT).
          //   - an entry exists, succeeded, and its `newest` genuinely
          //     matches `preCommentCursor`'s pre-THIS-poll baseline: comments
          //     were consulted and POSITIVELY ruled out — "checked-unchanged".
          //   - an entry exists, succeeded, and `newest` differs from the
          //     pre-poll baseline (and is non-null): this delivery genuinely
          //     IS comment-caused, discovered via a DIFFERENT arm's already-
          //     paid-for fetch this same poll (e.g. a sibling watcher's
          //     ledger/crossDaemon check on the same key) — named `comment`
          //     directly, same as `verdict.commentId` above, not a fourth
          //     `undetermined` shape. STATED RESIDUAL: if an untracked field
          //     (not status/summary/label/comment — e.g. assignee) is what
          //     actually bumped `updated` for THIS key, and a genuinely
          //     unrelated comment happens to have landed in the same window
          //     AND some other arm happened to have already fetched this
          //     poll, this could attribute the delivery to that coincidental
          //     comment. Strictly better than the prior "never even try",
          //     not a claim of perfect causal precision — see this module's
          //     own PR description and Confluence doc.
          const cached = commentsCache.get(key);
          if (!cached) return finalize(key, watcher, { deliver: true, reason: { undetermined: "unchecked" } });
          const peeked = await cached;
          if (!peeked.ok) return finalize(key, watcher, { deliver: true, reason: { undetermined: "check-failed" } });
          const preBaseline = preCommentCursor.has(key) ? (preCommentCursor.get(key) ?? null) : undefined;
          if (preBaseline !== undefined && peeked.newest !== null && peeked.newest !== preBaseline) {
            return finalize(key, watcher, { deliver: true, reason: { comment: peeked.newest } });
          }
          return finalize(key, watcher, { deliver: true, reason: { undetermined: "checked-unchanged" } });
        },
      };
    },
  };
}

/**
 * BUTCHR-307: `discovery.search()`'s own stand-down wiring — the ONE place
 * that stamps `.asleep` onto the resource `T`, per this module's `verdictFor`
 * doc comment (the flag enters through the snapshot, never through
 * `verdictFor` consulting a registry). Also where the lost-wake bound
 * (`tickMaxSleep`) and the seen-set memory bound (`forgetMissing`) actually
 * run — both need I/O-adjacent, once-per-poll placement, and this is the
 * only function in this module called exactly once per poll before either
 * `verdictFor` pass. A `standDown` dep that force-wakes an id via
 * `tickMaxSleep` here does so BEFORE that same id's `.asleep` is computed
 * for this poll's snapshot, so a bound-expired issue already reads awake
 * this same poll, not one poll later.
 */
async function stampSleep(sd: StandDownRegistry, issues: readonly JiraIssue[]): Promise<JiraIssue[]> {
  const keys = new Set(issues.map((i) => i.key));
  sd.forgetMissing(keys);
  await Promise.all(issues.map((i) => sd.tickMaxSleep(i.key)));
  return issues.map((i) => (sd.isAsleep(i.key) ? { ...i, asleep: true } : i));
}

export function createIssueResourceType(deps: IssueResourceDeps): ResourceType<JiraIssue> {
  return {
    discovery: {
      idOf: issueIdOf,
      search: async () => {
        const issues = await deps.search(ISSUE_JQL);
        return deps.standDown ? stampSleep(deps.standDown, issues) : issues;
      },
      related: createRelated(deps),
    },
    activation: ISSUE_ACTIVATION,
    eventRules: createIssueEventRules(deps),
    spawnConfig: ISSUE_SPAWN_CONFIG,
  };
}
