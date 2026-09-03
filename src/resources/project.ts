/**
 * The project tier expressed as ONE instance of ResourceType<ProjectResource>
 * (BUTCHR-67/BUTCHR-81), the second instance of BUTCHR-64's abstraction —
 * src/resources/issue.ts is the first, and its own top comment is this
 * module's worked example.
 *
 * FOUR DECLARATIONS, per the story ticket:
 *
 * - DISCOVERY: `GET /rest/api/3/project/search?status=live`
 *   (`AtlassianOps.searchProjects`), then `lead.accountId` filtered CLIENT
 *   SIDE against this credential's own account (`AtlassianOps.getMyself`).
 *   MEASURED live (2026-09-01): the server-side `leadAccountId` query param
 *   is silently ignored — a bogus id returns the SAME 9 live projects as no
 *   filter at all — so server-side filtering is not an option here, only an
 *   illusion of one; see `searchProjects`'s own doc comment on AtlassianOps.
 * - ACTIVATION: `verdictFor`, per the wake seam BUTCHR-66 published and the
 *   epic pinned (see this module's `projectVerdict`) — a PURE, synchronous
 *   comparison of fields `discovery.search()` already gathered against
 *   watermarks read from the same place. No I/O here; see `loadProject`
 *   below for where the I/O actually happens.
 * - EVENT RULES: the SAME watermark comparison, reused for the "already
 *   awake, tell it something changed" nudge path — see this module's top
 *   comment under "ONE PREDICATE, TWO CONSUMERS" below.
 * - SPAWN CONFIG: `PROJECT_SPAWN_CONFIG` — `issuetype: "project"`, already
 *   wired into the shared brief/model/effort tables by BUTCHR-71
 *   (src/agents/workspace.ts); this module only ever produces that string,
 *   never re-implements the selection.
 *
 * ELIGIBILITY (Declaration 2): `live` means ELIGIBLE, not resident — a
 * project is eligible only when it is ALSO led by this credential AND
 * carries a readable `butchr` entity property naming its root doc.
 * MEASURED live (2026-09-01, re-confirmed twice independently — this
 * module's own read and the story's reviewer's, on two DIFFERENT
 * credentials): of the 9 live projects, the archive project (KAN) and one
 * sample project (SAM1) both return HTTP 404 for `GET
 * /rest/api/3/project/{key}/properties/butchr`; the other 7 (ASSIST,
 * BUTCHR, CATA, LIBS, RINTH, SCHEM, SICKOS) return it populated, each
 * naming its OWN `space`/`rootDoc`. No project key is ever named in this
 * module's logic — see `loadProject`'s eligibility check, which fails
 * closed on ANY unreadable/incomplete property, not on an identity.
 *
 * `archiveProject` on that property is a POINTER, not a flag: every one of
 * the 7 readable properties names KAN as `archiveProject` identically —
 * KAN is the archive project because the others point at it, not because
 * it carries a marker on itself. This module never reads that field at
 * all; "archived" is out of scope for BUTCHR-67's discovery, which only
 * ever sees `status=live` results in the first place (an archived project
 * never appears in this module's own search results, so there is nothing
 * for this module to exclude on that basis).
 *
 * ACCOUNT RESOLUTION (Declaration 1): "the configured user" is resolved
 * LIVE, per poll, from this credential's own `GET /rest/api/3/myself` —
 * never hardcoded and never a new config knob. MEASURED (2026-09-01): this
 * workspace's own daemon credential and its story reviewer's each resolve
 * to a DIFFERENT accountId — the epic's tiers deliberately run as separate
 * accounts, so a value copied from either ticket would be wrong on the
 * other daemon. See `resolveAccountId` below.
 *
 * WATERMARKS AND WHERE THEY LIVE (the wake seam's hard constraint): a
 * watermark must be READABLE by the daemon at discovery time and WRITABLE
 * by the project agent while it runs, and — the load-bearing rule — it may
 * be advanced ONLY by the agent, after it acts, never by the daemon and
 * never at spawn time (BUTCHR-66's ruling: advancing it at spawn would make
 * spawning equal readiness, the exact thing "the state is the message" is
 * meant to prevent).
 *
 * CHOSEN: the existing `butchr` project entity property, under a new `wake`
 * sub-key (`{version, comment, epics}`), read via the SAME
 * `getProjectProperty` call `loadProject` already makes for eligibility —
 * no second read — and written via ONE new op, `AtlassianOps.setProjectProperty`
 * (MEASURED live, 2026-09-01: this credential can write a project property
 * it does not lead — permission is gated on Jira's Administer
 * Jira/Projects, not on leadership; see that op's doc comment).
 *
 * REJECTED, with the reason: (a) a marker embedded in the root doc BODY —
 * the doc is a page a human or agent may freely rewrite in full
 * (`set_doc`/`setProjectDoc` is a full-body REPLACE), so a body-embedded
 * marker would be silently lost on the next unrelated edit, and parsing a
 * hidden marker out of otherwise-human content is fragile in a way a
 * structured property value is not; (b) a second, new Confluence page
 * property — rejected as a second read surface next to the entity property
 * discovery already treats as this project's one canonical durable-state
 * store; (c) extending the Jira-keyed own-write ledger
 * (src/jira-watch/own-writes.ts) — MEASURED unusable for a project key (its
 * `search("key IN (...)")` silently returns empty for a bare project key,
 * confirmed independently by this story and by BUTCHR-65), and a ledger
 * entry answers a different question ("was this MY write") than a
 * watermark ("has anyone's write been acted on yet") — the latter is what
 * `verdictFor` actually needs, and what closes the self-wake hazard below
 * with no ledger involved at all.
 *
 * WHO WRITES THE WATERMARK — A STATED, DELIBERATE GAP: this module
 * advances the COMMENT watermark itself, from `src/tools/speak.ts`
 * (Hazard 1 — a project's own `report_to_boss`/`ask_boss` call is the one
 * write this story owns end-to-end). The VERSION and per-EPIC watermarks
 * have no call site inside this story's scope to advance them from: doing
 * so requires the project agent to check in as its LAST act before exiting,
 * and "exit" is BUTCHR-66's wake MECHANISM to own, not this story's (the
 * project tool surface that would carry a check-in verb is BUTCHR-65,
 * explicitly out of scope here too). `advanceProjectWatermark` below is
 * exported, tested, and ready for that exit hook to call with
 * `{version, epic}` — this is reported on BUTCHR-81 and in this story's doc
 * as a live, stated cross-story dependency rather than silently assumed:
 * until something calls it, an eligible project's version/epic watermarks
 * never advance past their initial (absent) state, so `verdictFor` will
 * correctly, honestly report `active` for them (fail-open — an unset
 * watermark means "never checked in", not "caught up"; see `projectVerdict`)
 * rather than silently under-reporting activity because a comparison was
 * skipped.
 *
 * ONE PREDICATE, TWO CONSUMERS (per BUTCHR-66's ruling): `verdictFor`
 * decides whether an agent should EXIST at all (the wake path — a sleeping
 * project has no agent, so a diff-based nudge has no recipient and would
 * fail silently). `eventRules.poll` decides whether an ALREADY-RUNNING
 * agent should be TOLD something (the nudge path). Both consume the exact
 * same watermark comparison; `eventRules.poll` additionally diffs prev/next
 * snapshots first (`changedPrimary`) purely so an unchanged poll produces
 * zero notify-stage work, matching the issue tier's own `changedKeys`
 * shape — it is not a second decision mechanism.
 *
 * HAZARD 1 CLOSED (self-wake loop, see src/tools/speak.ts): a project's own
 * `report_to_boss`/`ask_boss` posts a footer comment via `commentOnPage`,
 * then immediately advances THIS project's `wake.comment` watermark to the
 * id `commentOnPage` just returned — synchronously with the write, before
 * any poll can observe it. The very next `loadProject` read sees
 * `observedCommentId === watermark.comment` for that write, so it is never
 * counted as a pending trigger by EITHER `verdictFor` or `eventRules`. A
 * FOREIGN comment never goes through `speakOnOwnChannel`, so it is never
 * watermarked here and still registers as a pending trigger — the failure
 * condition a suppression must not also swallow. See
 * `test/unit/project-resource-type.test.ts` for the failure-condition-first
 * proof (own comment -> asleep stays asleep; foreign comment -> wakes).
 *
 * HAZARD 2 (daemon-side escalation destination for a blocked project
 * agent) is NOT in this module — it is a one-line change at the daemon's
 * existing escalator-wiring seam (`src/daemon/index.ts`), routing through
 * the ALREADY-SHIPPED `speakOnOwnChannel` (src/tools/speak.ts) rather than
 * `ops.addComment` directly. Documented there, not duplicated here, because
 * this module owns discovery/activation/events, not daemon wiring.
 *
 * WHAT THIS MODULE DOES NOT DO: wire a `runResourceLoop` call for projects
 * into `src/daemon/index.ts`'s actual startup, or restart/deploy anything —
 * both are explicitly the later "live proof" story's job, not this one's.
 * `PROJECT_POLL_INTERVAL_MS` below is the interval this story is choosing
 * and stating (per the epic's instruction that the polling COST is this
 * story's to own, the cadence MECHANISM already being generic — see that
 * constant's own comment for the call-count budget behind the number).
 */
import type { AtlassianOps } from "../tools/atlassian.js";
import type { JiraIssue } from "../atlassian/types.js";
import type {
  Activation,
  EventPoll,
  EventRules,
  EventVerdict,
  PollSnapshot,
  ResourceType,
  SpawnConfig,
} from "./types.js";

const PROPERTY_KEY = "butchr";

/**
 * Mirrors BUTCHR-66's pinned seam (relayed verbatim on BUTCHR-81,
 * 2026-09-01T17:31): `Activation<T>.verdictFor(resource): ActivationVerdict`,
 * REPLACING `isActive` on `src/resources/types.ts`'s `Activation<T>`. That
 * widening is BUTCHR-66's edit to make, not this module's — the epic ruled
 * BUTCHR-66 lands it BEFORE this story's PR, and this module is written
 * against that pinned shape rather than against today's `isActive: boolean`.
 * If `Activation<T>` has not actually widened by the time this module is
 * otherwise ready, that is reported on BUTCHR-81 as a blocking dependency —
 * this module does not work around it by touching types.ts or ISSUE_ACTIVATION
 * itself (both explicitly out of scope; see this file's top comment).
 */
export type ActivationVerdict = "active" | "asleep" | "inactive";

/** A project's wake watermarks — see this module's top comment for where they live and who writes them. */
export interface ProjectWatermark {
  /** Last root-doc page version this project has been acted on through, or `null` if never recorded. */
  version: number | null;
  /** Last root-doc footer-comment id this project has been acted on through, or `null` if never recorded. */
  comment: string | null;
  /**
   * Per in-review epic key -> the newest comment id on that epic, as of the
   * last time this project checked in on it. A key ABSENT from this map
   * means "not currently known to be in review, as of the last check-in" —
   * see the two-part note below on why absence, not a stale value, is what
   * makes re-entry into review observable.
   *
   * TWO DEFECTS, FOUND AT REVIEW BEFORE MERGE, BOTH SETTLED HERE:
   *
   * (1) A comment id is REQUIRED, not `updated` (BUTCHR-81, first attempted
   * fix rejected): `updated` looked attractive because it also bumps on a
   * status transition, appearing to catch "entered review" for free. MEASURED
   * live, twice — a plain comment add, AND a plain LABEL add with no comment
   * at all, both moved `updated`. And this daemon's own `agent:*`/`pr:*`
   * label sync writes to every issue in its active set CONSTANTLY (MEASURED
   * live on a real In-Review ticket: 8 label changes in 17 minutes, `updated`
   * exactly matching the last one) — `ISSUE_JQL` has no issuetype filter, so
   * an in-review EPIC is label-synced identically. At this story's own
   * 5-minute poll interval against ~1-3 minute label churn, an
   * `updated`-keyed watermark is behind on EVERY poll for as long as any
   * epic sits in review — active permanently, not occasionally noisy. A
   * comment id is immune to this: nothing but an actual comment moves it.
   *
   * (2) Re-entry is caught by PRUNING, not by the compared value: this
   * module NEVER prunes an entry out of this map on its own (see
   * `advanceProjectWatermark` below) — the project agent's own `check_in`
   * (src/tools/defs.ts) REPLACES this whole map with exactly the
   * currently-in-review set every time it checks in, rather than merging
   * one key into it. An epic that leaves review is therefore absent from
   * the NEXT check-in's replacement map; when it re-enters, it is absent
   * from `wm.epics` again and is treated as never-acted-on — the same
   * "absence = active" comparison already used for a first-ever entry,
   * doing double duty rather than needing a second mechanism. This keeps
   * the load-bearing rule intact: only the AGENT, as its own last act,
   * ever advances (or prunes) this map — never the daemon, never at spawn.
   *
   * A `pr:*` label transition on an in-review ticket (also part of the
   * measured churn) is neither "entered review" nor "commented on while in
   * review" — it must not wake the project, and a comment-id watermark
   * cannot confuse the two, since a label write is not a comment.
   */
  epics: Readonly<Record<string, string | null>>;
}

/** One epic currently `In Review` in a project, as `loadProject` observed it this poll. */
export interface ProjectEpic {
  key: string;
  /** This epic's newest comment id, or `null` if it has none — see `ProjectWatermark.epics`'s doc comment for why a comment id, not `updated`. */
  newestCommentId: string | null;
}

/**
 * The project tier's `T`. Deliberately fatter than `JiraIssue` — per the
 * pinned seam, `verdictFor` must be synchronous and pure, so every field it
 * needs is gathered here, by discovery's own I/O, rather than looked up
 * later (see this file's top comment, "ONE PREDICATE, TWO CONSUMERS").
 */
export interface ProjectResource {
  key: string;
  name: string;
  /** Live, led by this credential, AND carries a readable `butchr` property naming a root doc — see this module's top comment. `false` short-circuits `verdictFor` to `"inactive"` without consulting any watermark. */
  eligible: boolean;
  rootDocId: string | null;
  observedVersion: number | null;
  observedCommentId: string | null;
  observedEpics: readonly ProjectEpic[];
  watermark: ProjectWatermark;
}

export const projectIdOf = (p: ProjectResource): string => p.key;

const EMPTY_WATERMARK: ProjectWatermark = { version: null, comment: null, epics: {} };

/**
 * The pure comparison at the center of this module — see "ONE PREDICATE,
 * TWO CONSUMERS" above. FAIL-OPEN by construction, matching the issue
 * tier's own baseline philosophy (src/resources/issue.ts's `commentCursor`
 * doc comment): an absent watermark (`null`, or an epic key never seen
 * before) always compares as "behind", never as "caught up" — a project
 * this module has never recorded a check-in for gets an agent, rather than
 * silently sleeping forever because a comparison had nothing to compare
 * against.
 *
 * Failure condition, stated before this is ever exercised by a test: this
 * function must return `"inactive"` for every ineligible fixture regardless
 * of its watermark fields, `"asleep"` only when eligible AND every
 * observed/watermark pair is exactly caught up, and `"active"` the instant
 * ANY one of the three is behind — a fixture engineered to be behind on
 * exactly one axis (version only, comment only, or one epic only) that
 * comes back `"asleep"` is this function failing.
 */
export function projectVerdict(p: ProjectResource): ActivationVerdict {
  if (!p.eligible) return "inactive";
  const wm = p.watermark;
  const versionBehind = p.observedVersion !== null && p.observedVersion !== wm.version;
  const commentBehind = p.observedCommentId !== null && p.observedCommentId !== wm.comment;
  // Absence from `wm.epics` (never acted on THIS review episode — including
  // a re-entry, since `check_in` REPLACES rather than merges this map, see
  // its own doc comment) and a stale comment id (acted on, but commented on
  // again since) are both simply "not equal to the watermarked value" —
  // `wm.epics[e.key]` is `undefined` for an absent key, which a real
  // `newestCommentId` (string) or even `null` both compare unequal to.
  const epicsBehind = p.observedEpics.some((e) => e.newestCommentId !== wm.epics[e.key]);
  return versionBehind || commentBehind || epicsBehind ? "active" : "asleep";
}

/** Written against the pinned seam — see `ActivationVerdict`'s own doc comment for the landing-order dependency this assumes. */
export const PROJECT_ACTIVATION: Activation<ProjectResource> = {
  verdictFor: projectVerdict,
};

/** `issuetype: "project"` is already wired into the shared brief/model/effort tables (BUTCHR-71, src/agents/workspace.ts) — this only ever produces that string, never re-implements the selection. `parent: null`: a project is top-level, never implementing anything. */
export const PROJECT_SPAWN_CONFIG: SpawnConfig<ProjectResource> = {
  specFor: (p) => ({ key: p.key, issuetype: "project", summary: p.name, parent: null }),
};

/**
 * The interval this story chooses and states, per the epic's instruction
 * that the polling COST (call count x cadence) is this story's to own — the
 * cadence MECHANISM is already generic (`intervalMs` is a plain
 * per-`runResourceLoop`-call argument, `src/daemon/loop.ts`). NOT the issue
 * tier's 15s: a resource whose activation may legitimately answer `asleep`
 * is, by definition, one where minutes of latency are acceptable — a human
 * commenting on a root doc does not expect a 15-second turnaround, and if a
 * signal genuinely needed that latency it would be an argument against that
 * resource sleeping at all.
 *
 * Budget behind this number (MEASURED live, 2026-09-01, this story):
 * per poll, for N eligible projects: 1 project search + N property reads +
 * 1 BATCHED version read (`getPageVersions`, MEASURED: N pages in one call)
 * + N comment reads (footer comments do NOT batch — MEASURED: a
 * batch-shaped call returns a plausible, wrong count with no error; see
 * `getPageComments`'s doc comment on AtlassianOps) + 1 BATCHED epic JQL
 * (MEASURED: `project IN (...) AND issuetype = Epic AND status = "In Review"`
 * is one valid call across every eligible project) + a handful of per-epic
 * comment reads, only for epics actually in review (usually zero). ~2N+3
 * calls/poll. At N=6 (today's product-project count under one credential):
 * ~15 calls/poll. At 15s that is ~3,600 calls/hour, indefinitely, while
 * every project sleeps — clearly wrong for a resource whose whole point is
 * that nothing is happening most of the time. At 5 minutes: ~180/hour, and
 * at a stated worst case of N=30 (a credential leading every live project
 * across every tier the identity plan might eventually settle on): ~63
 * calls/poll, ~756/hour — the interval dominates the batching by an order
 * of magnitude, which is why the cadence is the real decision here, not the
 * batching.
 */
export const PROJECT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Read-modify-write of ONLY the `wake` sub-key — see this file's top comment
 * for why the rest of the `butchr` property (owned by the external
 * scaffolding tool) is never overwritten wholesale.
 *
 * STATED RISK, NOT AN IMPLIED GUARANTEE: this reads the property immediately
 * before writing it back, but the two calls are NOT atomic — Jira's project
 * entity property endpoint has no compare-and-swap/version field to make
 * them so (contrast `updatePage`, which does exact this locking for
 * Confluence pages via `version.number`). A write landing between this
 * function's own read and write is last-writer-wins: it will not see the
 * concurrent change and its write will overwrite it. Accepted rather than
 * engineered around, because the only other writers of the `butchr`
 * property are humans and the external scaffolding tool that provisions a
 * project once, up front (`space`/`rootDoc`/`repos`/`archiveProject`/
 * `scaffolded`) — not a second, frequent, automated writer this function's
 * own call frequency could plausibly collide with. If that ever changes
 * (e.g. a second daemon-side writer of this same property), this function
 * needs real optimistic locking, not just this comment.
 */
/**
 * DEFECT 1 (BUTCHR-214/226): the numerically-larger of a stored value and an
 * incoming one, under TODAY's read order — `newestCommentId`'s max-by-
 * numeric-id reduce, the same order `projectVerdict`/`check_in` already
 * compare against. `incoming === undefined` means this patch never touched
 * this axis at all — the stored value passes through completely unchanged
 * (this is what makes a comment-only advance leave `version` alone, and vice
 * versa; see the call site below). BUTCHR-195/199 own updating this
 * expression of order if/when their migration changes what "newest" means
 * for this field — this function is deliberately written against today's
 * scalar, not the seen-set 195 favours, per this ticket's own boundary.
 *
 * A stored value that is not a finite number is treated as ABSENT, not as
 * "smaller than everything": a `null`/never-set watermark is the normal
 * first-write case (see `ProjectWatermark`'s own doc comments, "absent means
 * never checked in"), and a stored value that is some OTHER non-numeric
 * garbage (outside this guard's control — e.g. hand-edited via the raw
 * Jira API) must not silently coerce to `NaN` and then compare false against
 * everything, which would silently swallow every future real write forever.
 * Both resolve the same way: accept the incoming value outright rather than
 * comparing against something that cannot be trusted as an order.
 *
 * An incoming value that is not a finite number (a caller bug, since every
 * real caller only ever passes a value it read off Jira/Confluence) is
 * treated as the ABSENT case in the other direction: kept out, so a bad
 * write can never lower a genuinely numeric stored value — "no writer may
 * lower it" holds even when the writer itself is confused.
 */
function monotonicMax(stored: number | null | undefined, incoming: number | undefined): number | null {
  if (incoming === undefined) return stored ?? null;
  if (!Number.isFinite(incoming)) return stored ?? null;
  if (stored === null || stored === undefined || !Number.isFinite(stored)) return incoming;
  return Math.max(stored, incoming);
}

/**
 * `monotonicMax`'s counterpart for `comment`, which is stored as a numeric
 * STRING (a Confluence comment id) rather than a `number` — compared
 * numerically (same order as `newestCommentId`) but the WINNING side's
 * original string is what gets stored, never a re-stringified number, so an
 * id is never reformatted by round-tripping through this guard.
 */
function monotonicMaxId(stored: string | null | undefined, incoming: string | undefined): string | null {
  if (incoming === undefined) return stored ?? null;
  const incomingNum = Number(incoming);
  if (!Number.isFinite(incomingNum)) return stored ?? null;
  if (stored === null || stored === undefined) return incoming;
  const storedNum = Number(stored);
  if (!Number.isFinite(storedNum)) return incoming;
  return incomingNum >= storedNum ? incoming : stored;
}

/**
 * DEFECT 1b (BUTCHR-214/226) — the swallowed watermark-write failure is a
 * SECOND, INDEPENDENT mechanism that produces the identical "wakes on its
 * own write" symptom as defect 1, by staleness rather than regression: the
 * write below is deliberately fail-open (BUTCHR-105 — a bookkeeping failure
 * must never fail the caller's `report_to_boss`/`ask_boss`/`set_doc`), so a
 * persistent rejection (MEASURED live, BUTCHR-115: a 403 from a project-tier
 * account lacking write permission) left the true stored watermark forever
 * behind the page's real max, waking the project on its own already-posted
 * complaint every poll, indefinitely.
 *
 * THE CHOSEN MECHANISM, AND WHY, AGAINST THE ALTERNATIVES THIS TICKET NAMED:
 * a bounded in-PROCESS (never persisted) fallback — the version/comment this
 * process most recently tried and failed to persist for a project, merged
 * into BOTH the next read (`loadProjects`, via `mergePendingFallback` below)
 * and the next write attempt (this function, so a LATER successful write —
 * from ANY caller, not necessarily the one that failed — durably absorbs
 * what an earlier one could not persist). Rejected alternatives:
 *   - A bare RETRY inside this function fixes only a TRANSIENT failure
 *     (timeout, rate limit). It does nothing for the measured case — a
 *     permission error is not fixed by retrying it — so retry alone would
 *     leave defect 1b's actual production incident unfixed. (A retry is
 *     still cheap insurance and composes fine with this fallback, but this
 *     ticket's time is better spent on the mechanism that actually closes
 *     the measured gap; not added here to keep one mechanism, not two.)
 *   - A DURABLE side-channel (a second Jira/Confluence write, or changing
 *     what the `wake` property itself stores) would need BUTCHR-195/199's
 *     sign-off (they own the stored field's meaning) and is exactly the
 *     "stop and ask" tripwire this ticket names — not needed here, because
 *     this fallback changes nothing about what is PERSISTED or what it
 *     means; it only changes what this process additionally consults before
 *     deciding, entirely in memory.
 * ACCEPTED COST, STATED RATHER THAN HIDDEN: this resets on daemon restart,
 * same as the issue tier's own per-issue in-memory cursor (a DIFFERENT
 * mechanism on a DIFFERENT surface — not modified, not reused — but the same
 * accepted shape: in-memory resilience is not required to survive a
 * restart to be worth having). A persistent-failure incident that survives
 * a restart before its write ever succeeds will resume waking the project
 * until then — a real gap, and the reason the WARNING log line below stays
 * loud rather than being treated as fully closed.
 */
const pendingWatermarkFallback = new Map<string, { version: number | null; comment: string | null; reconcile: boolean }>();

/** Test-only: `pendingWatermarkFallback` is process-lifetime state shared across every caller in this module, so a test suite that reuses a project key across tests (as this file's own fixtures do) must reset it between tests to avoid one test's failed write leaking into another's assertions. */
export function resetPendingWatermarkFallbackForTests(): void {
  pendingWatermarkFallback.clear();
}

/**
 * `loadProjects`' own merge of a persisted watermark with any still-pending
 * in-memory fallback for the same project — see `pendingWatermarkFallback`'s
 * doc comment. Never touches `epics` (out of this fallback's scope; see that
 * doc comment).
 *
 * `pending.reconcile` (BUTCHR-214/226 review round 1 — see `advanceProjectWatermark`'s
 * own "RECONCILING VS SUPPRESSING WRITES" section) decides HOW the merge
 * happens, not just whether: a pending value that came from a RECONCILING
 * write (`check_in`'s complete, authoritative observation) is used DIRECTLY,
 * never `monotonicMax`ed against the persisted value — that authoritative
 * value may legitimately be LOWER (the previous top comment was deleted),
 * and comparing it against a stale, still-higher persisted value would keep
 * the higher (wrong) one, silently re-raising the ceiling `check_in` was
 * trying to lower and reproducing the exact permanent-spawn-loop this round
 * exists to fix. A pending value from a SUPPRESSION write is still merged
 * via `monotonicMax`/`monotonicMaxId` — it is a partial fact, not a complete
 * observation, so a persisted value that is already higher must still win.
 */
function mergePendingFallback(projectKey: string, persisted: ProjectWatermark): ProjectWatermark {
  const pending = pendingWatermarkFallback.get(projectKey);
  if (!pending) return persisted;
  if (pending.reconcile) {
    return { version: pending.version, comment: pending.comment, epics: persisted.epics };
  }
  return {
    version: monotonicMax(persisted.version, pending.version ?? undefined),
    comment: monotonicMaxId(persisted.comment, pending.comment ?? undefined),
    epics: persisted.epics,
  };
}

/**
 * RECONCILING VS SUPPRESSING WRITES (BUTCHR-214/226 review round 1 —
 * corrects a premise this ticket started from: "`check_in` cannot regress
 * the watermark by construction" is not quite true. It cannot regress it
 * from a STALE value, but it legitimately observes a LOWER true max when
 * the previously-newest comment is deleted, and the monotonic guard alone
 * blocks exactly that recovery, turning a deletion into a PERMANENT spawn
 * loop `check_in` — the designated recovery path — can never clear, since
 * ids are drawn non-monotonically from a wide range with no guarantee a
 * higher one ever arrives again.
 *
 * The fix is not to weaken the guard — it is to recognize that this
 * module's two write shapes are not the same kind of fact:
 *   - a SUPPRESSION write (`speakOnOwnChannel`, `setProjectDoc`) says "I
 *     just created this id/version" — a PARTIAL fact about one write. It
 *     must never lower the watermark; `monotonicMax`/`monotonicMaxId` above
 *     are exactly right for it, unchanged.
 *   - a RECONCILING write (`check_in` only) says "here is the max over
 *     EVERYTHING currently on the page" — a COMPLETE observation. It may
 *     set the watermark authoritatively, INCLUDING DOWNWARD, which is
 *     exactly what it did before this guard existed and must keep doing.
 *
 * `patch.reconcile` makes this EXPLICIT at the call site — `check_in`
 * (src/tools/defs.ts) is the only caller that ever passes it — rather than
 * inferred/detected heuristically, per direct instruction: an explicit flag
 * is the whole point. This does not touch `projectVerdict`'s comparison and
 * does not change what the stored field MEANS (still "the comment id this
 * project has been acted on through") — BUTCHR-195/199's boundary is
 * untouched.
 */
export async function advanceProjectWatermark(
  ops: AtlassianOps,
  projectKey: string,
  patch: { version?: number; comment?: string; epics?: Readonly<Record<string, string | null>>; reconcile?: boolean },
  log: (line: string) => void = console.error,
): Promise<void> {
  // BUTCHR-105: uses `getProjectPropertyOrNull`, NOT the bare-catch
  // `getProjectProperty().catch(() => undefined)` this used to call. That
  // former version could not tell "genuinely absent (404)" apart from "the
  // read failed for some other reason (rate limit / timeout / permission
  // change)" — both collapsed to an empty base, and `setProjectProperty` is
  // a FULL-VALUE REPLACE (no partial-update variant), so a transient read
  // failure with a successful write would silently destroy the rest of the
  // property (`rootDoc`, `space`, `repos`, `archiveProject`, `scaffolded`) —
  // and `rootDoc` is not reconstructible from anything else in the system.
  // `getProjectPropertyOrNull` draws exactly the needed distinction (see its
  // own doc comment on `AtlassianOps`): a genuine 404 resolves `null`, which
  // is a real empty base and safe to build on; any OTHER rejection still
  // rejects, and this function does NOT catch it — the write below is never
  // reached, so an unreadable-for-unknown-reasons property can never become
  // the base of a replace. Fail-open is right for a read used to DECIDE
  // (e.g. discovery's eligibility check); this read is the BASE OF A
  // REPLACE, where the same fail-open shape means "assume the record was
  // empty" and silently deletes whatever was actually there.
  const current = (await ops.getProjectPropertyOrNull(projectKey, PROPERTY_KEY)) as Record<string, unknown> | null ?? {};
  const persistedWake: ProjectWatermark = {
    version: (current.wake as Partial<ProjectWatermark> | undefined)?.version ?? null,
    comment: (current.wake as Partial<ProjectWatermark> | undefined)?.comment ?? null,
    epics: (current.wake as Partial<ProjectWatermark> | undefined)?.epics ?? {},
  };

  let nextWake: ProjectWatermark;
  if (patch.reconcile) {
    // A complete, authoritative observation — bypasses BOTH the monotonic
    // guard and this process's own pending fallback entirely (see
    // `mergePendingFallback`'s doc comment for why merging either in here
    // would silently defeat the one write meant to recover from a deletion).
    // `epics` keeps its existing replace-only semantics, unaffected by this.
    nextWake = {
      version: patch.version ?? persistedWake.version,
      comment: patch.comment ?? persistedWake.comment,
      epics: patch.epics !== undefined ? patch.epics : persistedWake.epics,
    };
  } else {
    // SUPPRESSION WRITE: its floor is the more-trustworthy of the persisted
    // value and this process's own still-pending fallback — the SAME merge
    // `loadProjects` applies on read (`mergePendingFallback`, reused here so
    // read and write can never disagree about what "currently known" means),
    // never lowered by this write.
    const wake = mergePendingFallback(projectKey, persistedWake);
    // `epics`, when PROVIDED, REPLACES the whole map — deliberately NOT a
    // merge. This is the actual fix for rule 3's re-entry defect (see
    // `ProjectWatermark.epics`'s doc comment, point 2): the only caller that
    // ever passes `epics` is the project agent's own `check_in`
    // (src/tools/defs.ts), which always computes the FULL currently-in-review
    // set for the whole project in one JQL call — so "replace" here means
    // "this is now the complete truth", and an epic that has left review
    // since the last check-in is correctly dropped rather than lingering.
    // Omitting `epics` entirely (e.g. a version-only or comment-only advance)
    // leaves the existing map untouched. DELIBERATELY NOT monotonic (unlike
    // version/comment below): a smaller map after a check-in is exactly how
    // an epic leaving review gets pruned — "smaller" is not "behind" here.
    const epics = patch.epics !== undefined ? patch.epics : wake.epics;
    nextWake = {
      version: monotonicMax(wake.version, patch.version),
      comment: monotonicMaxId(wake.comment, patch.comment),
      epics,
    };
  }

  try {
    await ops.setProjectProperty(projectKey, PROPERTY_KEY, { ...current, wake: nextWake });
    // The durable write just became the new ground truth for whatever it
    // covered — for a suppression write, `nextWake` already absorbed any
    // pending value (see above); for a reconciling write, `nextWake` is
    // authoritative regardless of what was pending. Either way, dropping
    // the fallback outright here (never merging it back in) is correct.
    pendingWatermarkFallback.delete(projectKey);
  } catch (e) {
    // A reconciling write's own failure must ALSO be recorded as
    // authoritative (not monotonic-merged on a future read) — otherwise a
    // failed deletion-recovery would sit in the fallback, get compared with
    // `monotonicMax` against the still-stale-high persisted value on the
    // next read, and lose exactly the downward correction it was trying to
    // make. Once a pending entry has ever been authoritative, it stays that
    // way until a write actually succeeds and clears it (or another
    // reconciling write replaces it) — a later suppression write's own
    // `nextWake` was already computed FROM that authoritative floor above,
    // so preserving the flag here is what keeps read and write agreeing.
    const priorPending = pendingWatermarkFallback.get(projectKey);
    const reconcile = !!patch.reconcile || !!priorPending?.reconcile;
    pendingWatermarkFallback.set(projectKey, { version: nextWake.version, comment: nextWake.comment, reconcile });
    log(`  WARNING: [advanceProjectWatermark] persisted write failed for ${projectKey} (would-be version=${nextWake.version ?? "null"}, comment=${nextWake.comment ?? "null"}, reconcile=${reconcile}): ${(e as Error)?.message ?? e} — held in this process's in-memory fallback only (DEFECT 1b; resets on restart) so a poll does not wake on the very write that just failed to persist; the caller's own catch (if any) logs its own failure shape separately`);
    throw e;
  }
}

/**
 * Largest comment id by NUMERIC value — never by API return order, since
 * `getPageComments` requests no `sort` and this module does not depend on
 * one. Exported: the project tool surface's `check_in` verb
 * (src/tools/defs.ts) reuses this exact function rather than a second
 * "find the newest comment" implementation.
 *
 * CORRECTED (BUTCHR-198/BUTCHR-202): this doc comment used to assert that
 * Confluence footer-comment ids are "monotonically increasing
 * platform-wide, confirmed live". That was false. MEASURED, independently,
 * on two different project root docs: id order and creation-time order
 * disagree — on one doc, id `17334328` was created at `14:58:06.003Z` and
 * id `17104948` was created 24s LATER, at `14:58:30.387Z` (the later
 * comment's id is lower by 229,380). Replaying this project's own root-doc
 * footer comments in creation order against a max-id watermark, 6 of 10
 * would never have been seen. A max-by-numeric-id reduce, which is what
 * this function does, can therefore return the SAME value across a poll
 * even though a genuinely new (but lower-id) comment has arrived — the
 * comment is silently never observed, not merely mis-ordered. This
 * function, and every caller comparing its output against a watermark
 * (`projectVerdict`/`createProjectEventRules` in this file, `check_in` in
 * src/tools/defs.ts), is KNOWN-WRONG pending BUTCHR-198's fix. This ticket
 * (BUTCHR-202) documents the finding; it deliberately does not change this
 * function's behavior.
 */
export function newestCommentId(comments: readonly { id: string }[]): string | null {
  if (!comments.length) return null;
  return comments.reduce((max, c) => (Number(c.id) > Number(max) ? c.id : max), comments[0]!.id);
}

/** `project = "KEY-123"` -> `"KEY"`. Project keys never contain a hyphen (`PROJECT_ID_RE`, src/resources/id.ts) so the first split segment is always the whole prefix. */
const projectKeyOfIssue = (key: string): string => key.split("-", 1)[0]!;

export interface ProjectResourceDeps {
  ops: AtlassianOps;
  /**
   * Jira-shaped epic-in-review read (rule 3) — the SAME shape
   * `src/resources/issue.ts`'s `IssueResourceDeps.search` already takes,
   * wired from the daemon's existing `atlassian` client, per the ticket's
   * instruction not to add Confluence-shaped work to that client or a third
   * one. Per-epic COMMENTS are read via `ops.getIssueComments` instead of a
   * second injected dependency (BUTCHR-81, found at review): that op is the
   * exact same reader (same endpoint, same newest-first ordering, same cap)
   * `check_in`'s (src/tools/defs.ts) epic-watermark write already uses, so
   * the two can never disagree — see `getIssueComments`'s own doc comment
   * on AtlassianOps for the "one reader, not two" reasoning. Rule 3's epic
   * axis watermarks each epic's newest comment id, deliberately NOT its
   * `updated` field — see `ProjectWatermark.epics`'s doc comment for the
   * measured reason (label-sync churn on an in-review ticket bumps
   * `updated` every 1-3 minutes, faster than this story's own poll
   * interval, which would leave an `updated`-keyed watermark permanently
   * behind).
   */
  search: (jql: string) => Promise<JiraIssue[]>;
  /**
   * BUTCHR-91/BUTCHR-68: the opt-in scope for staffing — a project key must
   * be a member of this set to be admitted past the lead filter at all.
   * Applied inside `loadProjects` below, the SOLE discovery path this
   * module exposes (`createProjectResourceType`'s `discovery.search` calls
   * nothing else), so a caller cannot reach an eligible/active
   * `ProjectResource` for a non-allowlisted key by any other route — there
   * is no second entry point downstream (spawnConfig/activation/eventRules
   * all operate on whatever discovery already returned) that could bypass
   * this filter. REQUIRED, not optional-with-a-default: the daemon wiring
   * (src/daemon/index.ts) must construct this from its own config
   * deliberately, so "I forgot to pass an allowlist" is a compile error,
   * not a silent staff-everyone default. An EMPTY set is the deliberate
   * default at the config layer (src/config/config.ts's
   * `BUTCHR_PROJECT_ALLOWLIST`, unset by default) — empty here means zero
   * projects ever reach `led`, so zero are staffed, regardless of how many
   * live projects this credential actually leads.
   *
   * This is a ROLLOUT GATE, not an eligibility rule: eligibility is a
   * property of the project resource itself (this module's top comment,
   * Declaration 2 — live, led by this credential, and carrying a readable
   * `butchr` entity property naming a root doc), and is decided entirely
   * without consulting this set. A project absent from here is eligible but
   * deliberately not yet staffed — a different claim from "not eligible" —
   * because `projectVerdict` is fail-open by construction and no project on
   * this site has ever been checked in on: unlisted-but-eligible is the
   * state of every currently-eligible project, by design, until an operator
   * opts each one in by hand. Widening this set one key at a time, after
   * watching that project's agent behave safely under supervision, is the
   * intended path to trusting the fail-open verdict for it. Removing the
   * gate outright — reverting to "eligible implies staffed" — is not
   * expected to become reasonable on this codebase's current design: the
   * hazard it guards against (every eligible project going `active`
   * unattended on the very first poll) is a property of `projectVerdict`
   * being fail-open, not of the current project population, so it would
   * take a change to that verdict logic itself (e.g. requiring an explicit
   * per-project opt-in signal read FROM Jira/Confluence instead of from
   * this in-process set) before the gate could be retired rather than just
   * widened.
   */
  allowlist: ReadonlySet<string>;
}

/** One project this codebase has decided is a peer — see `resolveEligibleProjects`'s own doc comment. `rootDocId`/`wake` are internal fields `loadProjects` needs to build a full `ProjectResource`; the `list_peers` MCP verb (src/tools/defs.ts) reads only `key`/`name` off this and must NOT surface `rootDocId` (BUTCHR-188: a page id captured in a listing can go stale between the listing and a later send — resolve it fresh at send time instead). */
export interface EligibleProject {
  key: string;
  name: string;
  rootDocId: string;
  wake: Partial<ProjectWatermark> | undefined;
}

/** The result of `resolveEligibleProjects` — see its own doc comment. */
export interface ProjectEligibility {
  /** Every LIVE project led by this credential and admitted past `preFilter` (if any) — whether or not it went on to pass the property-read eligibility check. `loadProjects` uses this (not `eligible`) to still report a led-but-ineligible project as a `ProjectResource` with `eligible: false`, rather than silently dropping it from discovery. */
  admitted: readonly { key: string; name: string }[];
  /** The subset of `admitted` that is genuinely ELIGIBLE — see `resolveEligibleProjects`'s own doc comment for why this, and only this, is "who is a peer". */
  eligible: readonly EligibleProject[];
}

/**
 * THE SINGLE, REUSABLE RESOLVER for "who is a peer" / "who is eligible"
 * (BUTCHR-184/BUTCHR-188) — Declaration 2 in this file's top comment, live +
 * led by this credential + a readable `butchr` entity property naming a root
 * doc. `loadProjects` below and the `list_peers` MCP verb (src/tools/defs.ts)
 * BOTH call this and nothing else computes eligibility — there is
 * deliberately no second implementation anywhere in this codebase to drift
 * out of sync with this one (the same "exactly one of these" discipline as
 * the own-channel comment reader, and the cautionary tale of the two
 * disagreeing issue-key regexes in src/resources/id.ts). If a future call
 * site needs "who is a peer", it imports this function; it does not
 * recompute the lead filter or the property read inline.
 *
 * `preFilter`, OPTIONAL and applied to the lead-filtered set BEFORE any
 * per-project I/O (the property read): this is what lets `loadProjects`
 * plug in the staffing allowlist while preserving its existing cost
 * ordering — an unlisted project costs nothing beyond one in-memory check,
 * never reaching the property read (see `ProjectResourceDeps.allowlist`'s
 * own doc comment for why that gate must run before per-project I/O).
 * `list_peers` passes NO `preFilter` at all: peers are computed from
 * ELIGIBILITY alone, never the staffing allowlist — the allowlist is a
 * ROLLOUT GATE, not an eligibility rule (again, `ProjectResourceDeps.allowlist`'s
 * doc comment says so explicitly). An eligible-but-not-yet-allowlisted
 * project is therefore a valid peer even though no agent is currently
 * staffed for it — `tell_peer`ing it would post to a root page nobody
 * currently reads, an accepted consequence of this increment (BUTCHR-188),
 * not a defect to engineer around here.
 *
 * FAILS CLOSED, exactly matching `loadProjects`' pre-existing discipline
 * (BUTCHR-81): a genuinely missing `butchr` property (a clean 404, via
 * `getProjectPropertyOrNull`) simply excludes that project from `eligible`
 * (it still appears in `admitted`). ANY OTHER read failure — rate limit,
 * timeout, permission change — is left to PROPAGATE and reject this whole
 * call, deliberately, rather than being swallowed into a shorter-than-true
 * result: a project this call could not classify is not a peer, and it is
 * not silently dropped into "not a peer" either — the caller sees the error.
 */
export async function resolveEligibleProjects(
  ops: AtlassianOps,
  preFilter?: (key: string) => boolean,
): Promise<ProjectEligibility> {
  const me = await ops.getMyself();
  const raw = await ops.searchProjects("live");
  const led = raw.values.filter((p) => p.lead?.accountId === me.accountId);
  const admitted = preFilter ? led.filter((p) => preFilter(p.key)) : led;

  const properties = await Promise.all(
    admitted.map(async (p): Promise<EligibleProject | null> => {
      // Only a clean NOT-FOUND is ineligibility; any other rejection
      // propagates (see this function's own doc comment above).
      const property = (await ops.getProjectPropertyOrNull(p.key, PROPERTY_KEY)) as { rootDoc?: { id?: string }; wake?: Partial<ProjectWatermark> } | null;
      if (!property?.rootDoc?.id) return null;
      return { key: p.key, name: p.name, rootDocId: property.rootDoc.id, wake: property.wake };
    }),
  );
  const eligible = properties.filter((p): p is EligibleProject => p !== null);

  return { admitted: admitted.map((p) => ({ key: p.key, name: p.name })), eligible };
}

/**
 * One poll's worth of discovery I/O — see this file's top comment for the
 * batching this function performs and why (project search,
 * PROJECT_POLL_INTERVAL_MS's doc comment for the call-count budget).
 *
 * FAILURE-MODE DECISION (BUTCHR-81, raised by BUTCHR-66's reviewer): a
 * genuinely missing `butchr` property (404 — the archive/sample-project
 * case, Declaration 2's own eligibility signal) is expected and must not
 * fail this poll; ANY OTHER per-project read failure (rate limit, timeout,
 * permission change, …) here or anywhere else in this function is left to
 * PROPAGATE and fail the WHOLE poll, deliberately, rather than being
 * swallowed into a shorter-than-true result. Both failure directions are now
 * `resolveEligibleProjects`' own discipline, not reimplemented here — see
 * its doc comment.
 *
 * Why fail the whole poll rather than return the rest: `desiredFrom`
 * (src/daemon/loop.ts) treats "absent from this poll's discovery result" as
 * "stop this resource's agent" — the SAME reconciler behaviour that makes a
 * short list dangerous for a RUNNING project agent, not merely a missed
 * wake. A project this poll couldn't read is a project this poll knows
 * NOTHING new about; the safe default is to change nothing (retry at the
 * next poll, `PROJECT_POLL_INTERVAL_MS` later) rather than to report it
 * gone.
 */
async function loadProjects(deps: ProjectResourceDeps): Promise<ProjectResource[]> {
  // BUTCHR-91/BUTCHR-68: the allowlist is passed as `preFilter` so it keeps
  // running BEFORE any per-project I/O (property/version/comment reads),
  // exactly as before extraction — see `resolveEligibleProjects`'s own doc
  // comment and `ProjectResourceDeps.allowlist`'s.
  const { admitted, eligible } = await resolveEligibleProjects(deps.ops, (key) => deps.allowlist.has(key));

  const rootDocIds = eligible.map((p) => p.rootDocId);
  const versions = rootDocIds.length ? await deps.ops.getPageVersions(rootDocIds) : {};

  const commentsByProject = await Promise.all(eligible.map((p) => deps.ops.getPageComments(p.rootDocId)));

  const eligibleKeys = eligible.map((p) => p.key);
  const epicsInReview = eligibleKeys.length
    ? await deps.search(`project IN (${eligibleKeys.join(",")}) AND issuetype = Epic AND status = "In Review"`)
    : [];
  const epicsByProject = new Map<string, JiraIssue[]>();
  for (const epic of epicsInReview) {
    const key = projectKeyOfIssue(epic.key);
    (epicsByProject.get(key) ?? epicsByProject.set(key, []).get(key)!).push(epic);
  }

  const ineligible: ProjectResource[] = admitted
    .filter((p) => !eligible.some((e) => e.key === p.key))
    .map((p) => ({
      key: p.key,
      name: p.name,
      eligible: false,
      rootDocId: null,
      observedVersion: null,
      observedCommentId: null,
      observedEpics: [],
      watermark: EMPTY_WATERMARK,
    }));

  const resolved: ProjectResource[] = await Promise.all(
    eligible.map(async (p, i): Promise<ProjectResource> => {
      const rootDocId = p.rootDocId;
      const epics = epicsByProject.get(p.key) ?? [];
      // One getIssueComments() call per IN-REVIEW epic only (usually zero
      // epics, per this file's own call-count budget) — deliberately not
      // batched (there is no bulk comments read), and deliberately not
      // `updated` (see ProjectWatermark.epics's doc comment for the
      // measured label-churn reason). The SAME reader `check_in`
      // (src/tools/defs.ts) uses to watermark this same axis — see
      // `getIssueComments`'s own doc comment on AtlassianOps.
      const observedEpics: ProjectEpic[] = await Promise.all(
        epics.map(async (epic): Promise<ProjectEpic> => ({ key: epic.key, newestCommentId: newestCommentId((await deps.ops.getIssueComments(epic.key)).results) })),
      );
      const wake = p.wake;
      const persistedWatermark: ProjectWatermark = { version: wake?.version ?? null, comment: wake?.comment ?? null, epics: wake?.epics ?? {} };
      return {
        key: p.key,
        name: p.name,
        eligible: true,
        rootDocId,
        observedVersion: versions[rootDocId] ?? null,
        observedCommentId: newestCommentId(commentsByProject[i]!.results),
        observedEpics,
        // DEFECT 1b: merge in this process's own in-memory fallback (see
        // `pendingWatermarkFallback`'s doc comment) so a watermark write
        // that failed to persist still suppresses a poll's own re-read of
        // the very thing it just tried and failed to record.
        watermark: mergePendingFallback(p.key, persistedWatermark),
      };
    }),
  );

  return [...resolved, ...ineligible];
}

/**
 * Structural diff over OBSERVED fields only (never `watermark`, which the
 * SAME poll's own I/O just re-read and which advancing on its own is not an
 * "event") — mirrors the issue tier's `changedKeys` in shape and purpose:
 * an unchanged poll produces zero notify-stage work, so a project that is
 * genuinely `active` every poll (watermark never advanced — see this
 * file's top comment on the stated gap) is not re-nudged every single poll,
 * only when something about it actually moved since last time.
 */
function changed(prev: ProjectResource, next: ProjectResource): boolean {
  if (prev.eligible !== next.eligible) return true;
  if (prev.observedVersion !== next.observedVersion) return true;
  if (prev.observedCommentId !== next.observedCommentId) return true;
  if (prev.observedEpics.length !== next.observedEpics.length) return true;
  const prevEpics = new Map(prev.observedEpics.map((e) => [e.key, e.newestCommentId]));
  return next.observedEpics.some((e) => prevEpics.get(e.key) !== e.newestCommentId || !prevEpics.has(e.key));
}

/**
 * The nudge path for an ALREADY-AWAKE project agent — see this file's top
 * comment, "ONE PREDICATE, TWO CONSUMERS". No `related` (projects have none
 * of the issue tier's Implements-chain concept), so every notification is
 * primary/self, `watcher === key` always.
 */
export function createProjectEventRules(): EventRules<ProjectResource> {
  return {
    async poll(prev: PollSnapshot<ProjectResource>, next: PollSnapshot<ProjectResource>): Promise<EventPoll> {
      const prevByKey = new Map(prev.primary.map((p) => [p.key, p]));
      const nextByKey = new Map(next.primary.map((p) => [p.key, p]));
      const changedPrimary = next.primary.filter((p) => {
        const before = prevByKey.get(p.key);
        return before ? changed(before, p) : true;
      }).map((p) => p.key);
      return {
        changedPrimary,
        changedRelated: [],
        async decide(key: string, _watcher: string, _space: "primary" | "related"): Promise<EventVerdict> {
          const p = nextByKey.get(key);
          if (!p) return { deliver: false };
          // Reuses `projectVerdict` rather than a second decision mechanism
          // (per this file's top comment): a change that is already fully
          // watermarked (Hazard 1's own-comment case) verdicts `asleep`/
          // `inactive` here too, so the nudge is suppressed by the exact
          // same comparison that keeps activation from waking on it.
          return { deliver: projectVerdict(p) === "active" };
        },
      };
    },
  };
}

export function createProjectResourceType(deps: ProjectResourceDeps): ResourceType<ProjectResource> {
  return {
    discovery: {
      idOf: projectIdOf,
      search: () => loadProjects(deps),
    },
    activation: PROJECT_ACTIVATION,
    eventRules: createProjectEventRules(),
    spawnConfig: PROJECT_SPAWN_CONFIG,
  };
}
