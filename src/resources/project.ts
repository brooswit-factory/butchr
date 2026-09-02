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
import type { JiraComment, JiraIssue } from "../atlassian/types.js";
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
   * Per in-review epic key -> the epic's OWN `updated` timestamp (ISO-8601,
   * Jira's own field) at the moment it was last acted on. A key ABSENT from
   * this map means "never acted on this epic being in review at all".
   *
   * DELIBERATELY `updated`, NOT a comment id (BUTCHR-81 defect, caught at
   * review before merge): a per-epic `newestCommentId` watermark cannot
   * detect an epic RE-ENTERING review with no new comment (`submit_to_boss`
   * transitions status; it does not necessarily comment) — a stale,
   * never-pruned map entry from the epic's PRIOR review episode would still
   * equal the freshly observed value and the project would wrongly stay
   * `asleep`. Jira's `updated` field bumps on EVERY field change to an
   * issue, status transitions included (MEASURED live, BUTCHR-81
   * 2026-09-01: posting a comment alone moved `updated` forward) — so
   * leaving review and re-entering it is, by itself, at least one
   * transition that necessarily advances `updated` past whatever was
   * watermarked during the previous review episode. No pruning is needed:
   * the compared VALUE, not the map's membership, is what makes re-entry
   * observable.
   */
  epics: Readonly<Record<string, string>>;
}

/** One epic currently `In Review` in a project, as `loadProject` observed it this poll. */
export interface ProjectEpic {
  key: string;
  /** This epic's own Jira `updated` field — see `ProjectWatermark.epics`'s doc comment for why this, not a comment id. */
  updated: string;
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
  // A single comparison covers BOTH "entered review" and "commented while in
  // review": absence from `wm.epics` (never acted on) and a stale `updated`
  // (acted on, but review re-entered or commented on since) are both simply
  // "the current updated does not equal the watermarked one" — see
  // `ProjectWatermark.epics`'s doc comment for why `updated` rather than a
  // comment id makes this a single check instead of two.
  const epicsBehind = p.observedEpics.some((e) => e.updated !== wm.epics[e.key]);
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
export async function advanceProjectWatermark(
  ops: AtlassianOps,
  projectKey: string,
  patch: { version?: number; comment?: string; epics?: Readonly<Record<string, string>> },
): Promise<void> {
  // Fail open on an unreadable property (e.g. genuinely absent — 404) rather
  // than throwing: this write path is reachable from speakOnOwnChannel only
  // AFTER projectRootDoc has already succeeded for the same project this
  // same call (so the property exists in practice), but a helper this
  // general should not assume its own callers rather than defend against
  // the case, and starting from an empty base can only ever produce a
  // `wake`-only property (never one missing `rootDoc`), which discovery's
  // own eligibility check already treats as ineligible.
  const current = await ops.getProjectProperty(projectKey, PROPERTY_KEY).catch(() => undefined) as Record<string, unknown> | undefined ?? {};
  const wake = (current.wake as Partial<ProjectWatermark> | undefined) ?? {};
  // `epics` merges (never replaces) so watermarking one or a few epics in
  // one call never drops another epic's already-recorded entry — the same
  // additive discipline `addLabels`/`removeLabels` (atlassian-real.ts) use
  // for read-modify-write over a shared collection.
  const epics = { ...(wake.epics ?? {}), ...(patch.epics ?? {}) };
  const nextWake: ProjectWatermark = {
    version: patch.version ?? wake.version ?? null,
    comment: patch.comment ?? wake.comment ?? null,
    epics,
  };
  await ops.setProjectProperty(projectKey, PROPERTY_KEY, { ...current, wake: nextWake });
}

/** Largest comment id by NUMERIC value (Confluence footer-comment ids are monotonically increasing platform-wide, confirmed live) — never by API return order, since `getPageComments` requests no `sort` and this module does not depend on one. */
function newestCommentId(comments: readonly { id: string }[]): string | null {
  if (!comments.length) return null;
  return comments.reduce((max, c) => (Number(c.id) > Number(max) ? c.id : max), comments[0]!.id);
}

/** `project = "KEY-123"` -> `"KEY"`. Project keys never contain a hyphen (`PROJECT_ID_RE`, src/resources/id.ts) so the first split segment is always the whole prefix. */
const projectKeyOfIssue = (key: string): string => key.split("-", 1)[0]!;

export interface ProjectResourceDeps {
  ops: AtlassianOps;
  /**
   * Jira-shaped read (rule 3: epics in review) — the SAME shape
   * `src/resources/issue.ts`'s `IssueResourceDeps.search` already takes,
   * wired from the daemon's existing `atlassian` client, per the ticket's
   * instruction not to add Confluence-shaped work to that client or a third
   * one. No per-epic `comments()` dependency: rule 3's epic axis watermarks
   * the epic's own `updated` field (already returned by this same search),
   * not a comment id — see `ProjectWatermark.epics`'s doc comment.
   */
  search: (jql: string) => Promise<JiraIssue[]>;
}

interface EligibleCandidate {
  key: string;
  name: string;
  property: { rootDoc?: { id?: string }; wake?: Partial<ProjectWatermark> };
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
 * swallowed into a shorter-than-true result.
 *
 * Why fail the whole poll rather than return the rest: `desiredFrom`
 * (src/daemon/loop.ts) treats "absent from this poll's discovery result" as
 * "stop this resource's agent" — the SAME reconciler behaviour that makes a
 * short list dangerous for a RUNNING project agent, not merely a missed
 * wake. A project this poll couldn't read is a project this poll knows
 * NOTHING new about; the safe default is to change nothing (retry at the
 * next poll, `PROJECT_POLL_INTERVAL_MS` later) rather than to report it
 * gone. Only the ONE read that is EXPECTED to reject for a large, known
 * fraction of candidates (the property read, for every ineligible project)
 * gets a narrow, explicit not-found conversion; every other call in this
 * function is intentionally left uncaught.
 */
async function loadProjects(deps: ProjectResourceDeps): Promise<ProjectResource[]> {
  const me = await deps.ops.getMyself();
  const raw = await deps.ops.searchProjects("live");
  const led = raw.values.filter((p) => p.lead?.accountId === me.accountId);

  const properties = await Promise.all(
    led.map(async (p): Promise<EligibleCandidate | null> => {
      // Only a clean NOT-FOUND is ineligibility; any other rejection
      // propagates (see this function's own doc comment above).
      const property = (await deps.ops.getProjectPropertyOrNull(p.key, PROPERTY_KEY)) as EligibleCandidate["property"] | null;
      if (!property?.rootDoc?.id) return null;
      return { key: p.key, name: p.name, property };
    }),
  );
  const eligible = properties.filter((p): p is EligibleCandidate => p !== null);

  const rootDocIds = eligible.map((p) => p.property.rootDoc!.id!);
  const versions = rootDocIds.length ? await deps.ops.getPageVersions(rootDocIds) : {};

  const commentsByProject = await Promise.all(eligible.map((p) => deps.ops.getPageComments(p.property.rootDoc!.id!)));

  const eligibleKeys = eligible.map((p) => p.key);
  const epicsInReview = eligibleKeys.length
    ? await deps.search(`project IN (${eligibleKeys.join(",")}) AND issuetype = Epic AND status = "In Review"`)
    : [];
  const epicsByProject = new Map<string, JiraIssue[]>();
  for (const epic of epicsInReview) {
    const key = projectKeyOfIssue(epic.key);
    (epicsByProject.get(key) ?? epicsByProject.set(key, []).get(key)!).push(epic);
  }

  const ineligible: ProjectResource[] = led
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
      const rootDocId = p.property.rootDoc!.id!;
      const epics = epicsByProject.get(p.key) ?? [];
      // No extra call per epic: `updated` is already on every issue the
      // rule-3 JQL search returned.
      const observedEpics: ProjectEpic[] = epics.map((epic): ProjectEpic => ({ key: epic.key, updated: epic.updated }));
      const wake = p.property.wake;
      return {
        key: p.key,
        name: p.name,
        eligible: true,
        rootDocId,
        observedVersion: versions[rootDocId] ?? null,
        observedCommentId: newestCommentId(commentsByProject[i]!.results),
        observedEpics,
        watermark: { version: wake?.version ?? null, comment: wake?.comment ?? null, epics: wake?.epics ?? {} },
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
  const prevEpics = new Map(prev.observedEpics.map((e) => [e.key, e.updated]));
  return next.observedEpics.some((e) => prevEpics.get(e.key) !== e.updated || !prevEpics.has(e.key));
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
