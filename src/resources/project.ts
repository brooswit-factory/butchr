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
 * then immediately advances THIS project's `wake.commentsSeen` set
 * (BUTCHR-227: was a `wake.comment` scalar overwrite, now a pure add — see
 * `advanceProjectWatermark`'s own doc comment) to include the id
 * `commentOnPage` just returned — synchronously with the write, before any
 * poll can observe it. The very next `loadProject` read sees that id
 * already present in `watermark.commentsSeen`, so it is never counted as a
 * pending trigger by EITHER `verdictFor` or `eventRules` (both consume
 * `unseenCommentIds`, which excludes it). A FOREIGN comment never goes
 * through `speakOnOwnChannel`, so it is never watermarked here and still
 * registers as a pending trigger — the failure condition a suppression
 * must not also swallow. See `test/unit/project-resource-type.test.ts` for
 * the failure-condition-first proof (own comment -> asleep stays asleep;
 * foreign comment -> wakes).
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
 *
 * BUTCHR-227 — THE AXIS STATEMENT (DoD #15), stated once here because
 * `projectVerdict` below is a three-way OR and a reader must not be able to
 * infer that fixing "the watermark" meant all three fields: `version` OR
 * `commentsSeen`(as `comment` was) OR `epicsSeen`(as `epics` was) being
 * behind makes a project `"active"`. BUTCHR-227 CHANGES ONLY THE COMMENT
 * AXIS (`commentsSeen`, surface 1) AND THE EPICS AXIS (`epicsSeen`, surface
 * 2) — both from a scalar "newest id" to a seen SET, removing their
 * dependence on id ordering entirely. BUTCHR-227 DOES NOT TOUCH THE VERSION
 * AXIS: it is BUTCHR-208/BUTCHR-214's, page version numbers are genuinely
 * monotonic by construction (a real ordering guarantee, not an assumed
 * one), and it needs no migration from this ticket. Because the predicate
 * is an OR, a project this ticket makes fully correct about comments and
 * epics still wakes on the version axis if THAT axis has its own defect
 * (BUTCHR-208/214's to fix) — this ticket does not claim otherwise.
 *
 * BUTCHR-227 DoD #16 — THE BOUNDED-VS-ASCENDING FALSIFIER (checked, not
 * measured directly — no live Confluence access from this module): stated
 * before looking, this claim would be REFUTED by evidence that Confluence
 * footer-comment ids are drawn from a fixed, page-scoped pool rather than a
 * space shared across an entire tenant. Structural evidence points toward
 * ASCENDING (a moving target), not a fixed range: Confluence content ids
 * are documented as shared across every content type (pages, blogposts,
 * comments, attachments, …) tenant-wide, not scoped per page — a single
 * busy tenant issues far more ids overall than any one page's comment
 * count, so the tenant-wide maximum keeps climbing over calendar time even
 * though any ONE page's own comments draw non-monotonically from inside
 * that climbing range (which is the defect this ticket fixes — local
 * non-monotonicity within a globally ascending space, not a contradiction
 * of it). NOT independently re-measured by this ticket (get_doc_comments's
 * project-caller-only wall, again) — reported to BUTCHR-199 as a finding,
 * not asserted as settled. Per this ticket's own instruction, this finding
 * changes nothing about the design: a seen set is correct under EITHER
 * answer, which is the whole point of not choosing a threshold-shaped fix.
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
 * BUTCHR-227 DoD #9 / §6: the space ceiling on a Jira project entity
 * property VALUE, in bytes — see `ProjectWatermark.commentsSeen`'s own doc
 * comment for how this number was obtained (a web search surfacing
 * Atlassian's own stated limit; NOT a first-hand read of the rendered
 * reference page, and NOT asserted from memory) and re-verify it there if
 * it matters enough to confirm by hand.
 *
 * THIS IS DELIBERATELY NOT LEFT AS A COMMENT ALONE (BUTCHR-216's own point,
 * adopted by BUTCHR-199): a number measured once and written in a doc
 * comment is the self-declaring grade in its purest form — authoritative-
 * looking forever, silently wrong the moment the platform limit, the id
 * encoding, or the serialized shape changes, with nothing binding the
 * comment to what the code actually does. `assertWithinPropertySizeCeiling`
 * below is the same-call withdrawal instead: it converts "we believe N ids
 * fit" into "we find out on the run where it first stops being true".
 */
const PROJECT_PROPERTY_SIZE_CEILING_BYTES = 32768;

/**
 * BUTCHR-227 §6/DoD #9's runtime assertion, called at the ONE site that
 * serializes and writes the `butchr` project entity property
 * (`advanceProjectWatermark`, immediately before `setProjectProperty`) —
 * not duplicated at any other call site, so there is exactly one place
 * this bound is checked and exactly one place it could be forgotten.
 *
 * FAILS LOUDLY (throws), never swallows: a space bound that silently
 * overflows (Jira would reject the oversized write, or worse, truncate it
 * — this module has not measured which) is worse than one that fails
 * loudly here, before the network call, with a message naming the actual
 * ceiling to re-derive. Writer A (`check_in`) does not catch this — it
 * propagates to the calling agent, which is itself the "STOP and tell
 * BUTCHR-199" trigger this ticket's retention section names, not a defect.
 * Writer B (`speakOnOwnChannel`)'s existing fail-open `.catch` + WARNING
 * log (BUTCHR-105) still applies here — this assertion does not add a
 * second failure-handling policy, it feeds the existing one a real trigger
 * instead of a silent 400-or-worse from Jira's own side.
 */
function assertWithinPropertySizeCeiling(projectKey: string, propertyValue: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(propertyValue)).length;
  if (bytes > PROJECT_PROPERTY_SIZE_CEILING_BYTES) {
    throw new Error(
      `advanceProjectWatermark(${projectKey}): the "butchr" property would serialize to ${bytes} bytes, over the stated ${PROJECT_PROPERTY_SIZE_CEILING_BYTES}-byte Jira entity-property ceiling (see PROJECT_PROPERTY_SIZE_CEILING_BYTES's own doc comment for how that number was obtained and how to re-verify it) — refusing to write rather than risk a silent truncation or rejection. This is the retention section's stop-and-escalate trigger firing for real: report this to BUTCHR-199 rather than inventing a retention rule under this call site.`,
    );
  }
}

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

/**
 * A project's wake watermarks — see this module's top comment for where
 * they live and who writes them. This is the NORMALIZED in-memory shape
 * (BUTCHR-227) — the RAW stored JSON can also carry the pre-BUTCHR-227
 * legacy scalar fields (`comment`/`epics`); see `StoredWake` and
 * `normalizeWake` below for the read-time adapter that turns one into the
 * other. Nothing outside `normalizeWake`/`advanceProjectWatermark` ever
 * sees the legacy shape.
 *
 * IDS ARE STRINGS, COMPARED BY STRING EQUALITY / SET MEMBERSHIP ONLY.
 * There is deliberately no `Number()` and no magnitude/threshold comparison
 * anywhere on this path — see BUTCHR-227's ticket doc for why a threshold
 * ("drop everything below id N") is the exact bug this shape replaces, not
 * a variant of the fix.
 */
export interface ProjectWatermark {
  /** Last root-doc page version this project has been acted on through, or `null` if never recorded. Unrelated to the ordering defect (page versions ARE genuinely monotonic by construction) — untouched by BUTCHR-227, carried through as before. */
  version: number | null;
  /**
   * The root-doc axis's SEEN SET (BUTCHR-227) — every footer-comment id
   * this project has ever been recorded as having observed, unioned in by
   * every writer, NEVER pruned, NEVER replaced wholesale. Membership only:
   * an id not in this set is unseen, regardless of how it compares
   * numerically to anything already in it. See this module's
   * `normalizeWake` for how a pre-migration project's stored scalar
   * `comment` id seeds this set, and `advanceProjectWatermark` for why
   * "seen" and "woke" are different facts recorded here.
   *
   * NO RETENTION RULE, DECLARED (BUTCHR-227, BUTCHR-199's decision): a
   * member of this set asserts a timestamped PAST EVENT ("id X was
   * observed") which, per BUTCHR-151's measured finding, cannot go stale —
   * there is no correctness reason to ever remove an entry. What this has
   * instead is a SPACE bound, not a correctness one, and solving a space
   * bound with a correctness mechanism (evicting old-but-real entries) is
   * exactly how a simple fix re-acquires the complexity of the bug it
   * replaced — an evicted id and a never-seen id would again be
   * indistinguishable, which is THE HARD RULE this ticket's whole design
   * exists to avoid. So: no eviction, ever, from this module.
   *
   * THE STATED CEILING (verify by re-deriving, this is not asserted from
   * memory): a Jira project entity property VALUE is capped at 32768 bytes
   * total (`PROJECT_PROPERTY_SIZE_CEILING_BYTES`, this module), per
   * Atlassian's own Jira Cloud "Entity properties" reference
   * (https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/).
   * A DIRECT FETCH of that page did not resolve on this read — it renders
   * as a JS app and returned only navigation chrome, the same class of
   * incomplete-fetch BUTCHR-198 hit on a different Atlassian reference
   * page — so this number is a WEB SEARCH result surfacing that page's own
   * stated limit, not a first-hand read of the rendered reference. Treat
   * it the way BUTCHR-198 treated its own unconfirmed hedge: plausible,
   * not first-hand-verified; re-fetch or measure directly (write an
   * oversized property and observe the rejection) if this number is load-
   * bearing enough to be worth confirming by hand.
   *
   * NOT LEFT AS A COMMENT ALONE (BUTCHR-216's point, adopted by BUTCHR-199):
   * `assertWithinPropertySizeCeiling`, called from `advanceProjectWatermark`
   * at the one site that serializes and writes this property, ASSERTS the
   * real serialized size against this number on every write and fails
   * loudly rather than let a silently-stale comment paper over a platform
   * limit change, an id-encoding change, or a growing property shape. This
   * doc comment states the REASONING; that assertion is what stays true.
   *
   * This ceiling is shared by the WHOLE `butchr` property, not just this
   * array — `space`/`rootDoc`/`repos`/`archiveProject`/`scaffolded` plus
   * the legacy `comment`/`epics` scalars all count against the same 32768
   * bytes. Budgeting ~1000 bytes for everything else (unmeasured, a
   * round-number placeholder — re-measure a real property blob if this
   * gets tight) leaves ~31768 bytes for this array; a comment id is
   * currently 8 digits, so one JSON array entry (`"18153493",`) costs
   * ~11 bytes, for a capacity of roughly 2,800 ids.
   *
   * TODAY'S ACTUAL POPULATION (per BUTCHR-227's ticket doc's own replay,
   * the only measured data available): 17 ids on the one root doc measured
   * — roughly 0.6% of the ~2,800-id estimated capacity, so headroom is not
   * in doubt right now. This module still cannot measure a STEADY-STATE
   * accumulation RATE directly (`get_doc_comments` is project-caller-only
   * and refuses an issue-tier caller, the same wall BUTCHR-198 recorded
   * hitting), so "not in doubt now" is a snapshot, not a year-long
   * projection — the runtime assertion above is what makes that gap safe
   * to leave open rather than something this module must estimate under
   * this ticket.
   */
  commentsSeen: readonly string[];
  /**
   * Per in-review epic key -> that epic's SEEN SET (BUTCHR-227). A key
   * ABSENT from this map means "not currently known to be in review, as of
   * the last check-in" — unchanged from the pre-BUTCHR-227 scalar design,
   * see the two-part note below for why absence (not a stale value) is
   * what makes re-entry into review observable. Only the per-key VALUE
   * changed shape, from a single "newest comment id" scalar to a set.
   *
   * TWO DEFECTS, FOUND AT REVIEW BEFORE BUTCHR-67 MERGED, BOTH STILL
   * SETTLED HERE THE SAME WAY:
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
   * (2) Re-entry is caught by PRUNING THE KEY SET, not by the compared
   * value: this module NEVER prunes a key out of this map on its own (see
   * `advanceProjectWatermark` below) — the project agent's own `check_in`
   * (src/tools/defs.ts) REPLACES the whole KEY SET with exactly the
   * currently-in-review set every time it checks in (unioning VALUES for
   * surviving keys, see `advanceProjectWatermark`'s own doc comment for
   * why), rather than merging one key into it. An epic that leaves review
   * is therefore absent from the NEXT check-in's replacement map; when it
   * re-enters, it is absent from `wm.epicsSeen` again and is treated as
   * never-acted-on-this-episode — the same "absence = active" comparison
   * already used for a first-ever entry, doing double duty rather than
   * needing a second mechanism. This keeps the load-bearing rule intact:
   * only the AGENT, as its own last act, ever advances (or prunes) this
   * map — never the daemon, never at spawn.
   *
   * A `pr:*` label transition on an in-review ticket (also part of the
   * measured churn) is neither "entered review" nor "commented on while in
   * review" — it must not wake the project, and a comment-id seen-set
   * cannot confuse the two, since a label write is not a comment.
   */
  epicsSeen: Readonly<Record<string, readonly string[]>>;
}

/**
 * The RAW shape found in the `butchr` project entity property's `wake`
 * sub-key (BUTCHR-227) — a UNION of every shape this key has ever held,
 * not the normalized `ProjectWatermark` the rest of this module operates
 * on. `comment`/`epics` are the PRE-BUTCHR-227 legacy scalar fields.
 *
 * `comment`/`epics` ARE NEVER DELETED FROM STORAGE (see
 * `advanceProjectWatermark`) and ARE NEVER READ AGAIN once `commentsSeen`/
 * `epicsSeen` exist (see `normalizeWake`) — kept only as forensic evidence
 * of the ordering regression this ticket fixes. Nothing outside
 * `normalizeWake` and `advanceProjectWatermark`'s own read-modify-write
 * ever sees this type.
 */
interface StoredWake {
  version?: number | null;
  /** @deprecated pre-BUTCHR-227 scalar — see this interface's own doc comment. */
  comment?: string | null;
  /** @deprecated pre-BUTCHR-227 scalar map — see this interface's own doc comment. */
  epics?: Readonly<Record<string, string | null>>;
  commentsSeen?: readonly string[];
  epicsSeen?: Readonly<Record<string, readonly string[]>>;
}

/**
 * THE MIGRATION (BUTCHR-227) — a PURE READ-TIME SHAPE ADAPTER, called
 * everywhere the stored `wake` sub-key is deserialised: `loadProjects`'
 * own read below, AND `advanceProjectWatermark`'s read-modify-write (its
 * own "stored set" to union against is this function's OUTPUT, never the
 * raw JSON — otherwise a pre-migration project's first post-migration
 * write would union new ids onto an empty `commentsSeen` and silently
 * DROP the one id its legacy `comment` scalar had already genuinely seen).
 *
 * NEVER A WRITER, AND NEVER A THRESHOLD: the legacy scalar `comment` is
 * read ONLY as "this one id was definitely, truthfully seen" — never as
 * "everything at or below this id was seen" (the exact assumption that
 * regressed this project's watermark in the first place; see BUTCHR-227's
 * ticket doc for the measured evidence a scalar high-water-mark reading
 * would mishandle). A regressed legacy scalar therefore degrades
 * gracefully under this adapter: it simply seeds one fewer id into the
 * set, and every other previously-stepped-over comment still inside the
 * reader's page window (see `getPageComments`/`getIssueComments`'s own
 * doc comments for that window's size) re-delivers once, the next time it
 * is observed.
 *
 * Once `commentsSeen` (or `epicsSeen`, per key) exists in storage — even
 * as an empty array, which `??` treats as present, correctly — the
 * corresponding legacy field is NEVER consulted again. A brand-new project
 * with neither legacy nor new fields seeds `[]`, i.e. everything observed
 * is unseen, i.e. `"active"` — the same fail-open behavior a never-seen
 * project already had.
 */
function normalizeWake(wake: StoredWake | undefined): ProjectWatermark {
  const commentsSeen = wake?.commentsSeen ?? (wake?.comment ? [wake.comment] : []);
  const rawEpics: Readonly<Record<string, readonly string[] | string | null>> = wake?.epicsSeen ?? wake?.epics ?? {};
  const epicsSeen: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(rawEpics)) {
    epicsSeen[key] = Array.isArray(value) ? value : value ? [value] : [];
  }
  return { version: wake?.version ?? null, commentsSeen, epicsSeen };
}

/**
 * One epic currently `In Review` in a project, as `loadProject` observed
 * it this poll — EVERY comment id currently observed on it, not a single
 * "newest" one (BUTCHR-227: a "newest" concept requires an ordering this
 * module no longer assumes). See `ProjectResource.unseenEpicCommentIds`
 * for the derived subset actually novel against the stored watermark.
 */
export interface ProjectEpic {
  key: string;
  /** Every comment id `getIssueComments` returned for this epic this poll — see that op's own doc comment for its cap, which bounds what this can ever contain. */
  commentIds: readonly string[];
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
  /** Every comment id `getPageComments` returned for this project's root doc this poll — BUTCHR-227: the FULL observation, never collapsed to a "newest" scalar. See `unseenCommentIds` for the derived subset novel against the watermark, and `getPageComments`'s own doc comment for this read's pagination window (this module's stated blind spot: a comment outside that window is never observed, therefore never in this array, therefore never seen or woken — a pagination limitation, not the id-monotonicity defect this ticket fixes). */
  observedCommentIds: readonly string[];
  observedEpics: readonly ProjectEpic[];
  /**
   * THE CLASSIFICATION SEAM (BUTCHR-227, per the inter-epic agreement with
   * BUTCHR-208): `observedCommentIds` minus `watermark.commentsSeen` —
   * every id observed this poll that this project has never recorded
   * seeing before. "Seen" and "woke" are deliberately two different facts:
   * `check_in`/the suppression write record the FULL `observedCommentIds`
   * as seen regardless of this field, but `projectVerdict`/the nudge path
   * decide whether to wake/notify from THIS field. A future sender-class
   * filter (BUTCHR-208's remedy) belongs HERE, narrowing this field before
   * a decision is made from it — never folded back into `observedCommentIds`
   * itself, which must keep surfacing every observed id so a
   * classified-away comment is still recorded as seen (see this module's
   * top comment, "ONE PREDICATE, TWO CONSUMERS", for why the write and the
   * decision share one read).
   */
  unseenCommentIds: readonly string[];
  /** The same classification seam as `unseenCommentIds`, per in-review epic key — see that field's own doc comment. */
  unseenEpicCommentIds: Readonly<Record<string, readonly string[]>>;
  watermark: ProjectWatermark;
}

export const projectIdOf = (p: ProjectResource): string => p.key;

const EMPTY_WATERMARK: ProjectWatermark = { version: null, commentsSeen: [], epicsSeen: {} };

/** Set membership only — no ordering, no magnitude, no `Number()` (BUTCHR-227's hard rule). Exported for this module's own reuse between `projectVerdict`, `loadProjects`' unseen-field computation, and their tests; not part of this module's public API surface (not re-exported from an index). */
function unseenIds(observed: readonly string[], seen: readonly string[]): readonly string[] {
  if (observed.length === 0) return observed;
  const seenSet = new Set(seen);
  return observed.filter((id) => !seenSet.has(id));
}

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
  // BUTCHR-227: SET MEMBERSHIP, not scalar equality — active iff at least
  // one observed id is absent from the seen set. No ordering, no
  // magnitude, no `Number()` (this ticket's hard rule). `p.unseenCommentIds`
  // is exactly this computation, already done once by `loadProjects` (see
  // its own doc comment on the classification seam) — reused here rather
  // than recomputed, so the two can never disagree.
  const commentBehind = p.unseenCommentIds.length > 0;
  // Absence of a key from `wm.epicsSeen` (never acted on THIS review
  // episode — including a re-entry, since `check_in` REPLACES rather than
  // merges the KEY SET, see that map's own doc comment) means active
  // regardless of that epic's current comment count, including zero — the
  // same "absence = active" rule the pre-BUTCHR-227 scalar design used,
  // unchanged in shape. A key PRESENT in `wm.epicsSeen` is active iff this
  // poll observed an id for it that isn't in its stored set yet, which is
  // exactly `p.unseenEpicCommentIds[e.key]` — again reused, not
  // recomputed, from `loadProjects`.
  const epicsBehind = p.observedEpics.some((e) => !(e.key in wm.epicsSeen) || (p.unseenEpicCommentIds[e.key]?.length ?? 0) > 0);
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
 *
 * BUTCHR-227 — WRITER SEMANTICS CHANGED FROM OVERWRITE TO UNION:
 *
 * - `seenComments`, when provided, is UNIONED into the stored `commentsSeen`
 *   set — never a replace. This is what makes the two writers below both
 *   safe: WRITER A (`check_in`, src/tools/defs.ts) passes every id it
 *   observed this poll; WRITER B (the self-suppression write in
 *   `speakOnOwnChannel`, src/tools/speak.ts) passes just the one id of the
 *   comment it posted. Under overwrite semantics writer B was the ONLY one
 *   of the two writers that could ever REGRESS the watermark (it wrote
 *   whatever id it was given, whatever that id compared as). Under union,
 *   regression is not merely forbidden by this function's logic — it is
 *   UNREPRESENTABLE: a set union can only ever grow or stay the same size,
 *   so there is no patch shape writer B (or anything else) could pass that
 *   removes a previously-seen id from the stored set. That is a stronger
 *   claim than "this function refuses to shrink the set" — there is no
 *   code path here that even attempts a removal for a caller to bypass.
 * - `epics`, when PROVIDED, REPLACES the whole KEY SET (deliberately NOT a
 *   merge — unchanged in shape from before BUTCHR-227, see
 *   `ProjectWatermark.epicsSeen`'s own doc comment, point 2, for the
 *   re-entry-detection reasoning) — but for each key PRESENT in the patch,
 *   the VALUE is unioned against whatever this project already had stored
 *   for that key, never replaced. Per-key union matters independently of
 *   the key-set replace: `getIssueComments` is CAPPED (see that op's own
 *   doc comment on `AtlassianOps` for the exact number) — a value-level
 *   replace could drop an id a truncated read simply didn't return this
 *   particular poll, even though an earlier poll genuinely saw it.
 * - Both unions read against `normalizeWake`'s OUTPUT, never the raw stored
 *   JSON directly — see that function's own doc comment for why: reading
 *   raw JSON here would silently drop a legacy scalar's already-seen id on
 *   this project's very first post-migration write.
 * - THE LEGACY `comment`/`epics` SCALAR FIELDS ARE NEVER WRITTEN AND NEVER
 *   DELETED HERE: `nextWake` spreads `...wake` (the RAW stored object)
 *   first, so whatever legacy value was already there survives byte-for-
 *   byte, forensic evidence of the pre-BUTCHR-227 ordering regression, and
 *   this function never re-derives or overwrites either key.
 * - Omitting `seenComments`/`epics` entirely (e.g. a version-only advance)
 *   leaves the corresponding set(s) exactly as `normalizeWake` last
 *   resolved them — not the raw stored value, per the point above.
 */
export async function advanceProjectWatermark(
  ops: AtlassianOps,
  projectKey: string,
  patch: { version?: number; seenComments?: readonly string[]; epics?: Readonly<Record<string, readonly string[]>> },
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
  const wake = (current.wake as StoredWake | undefined) ?? {};
  const normalized = normalizeWake(wake);

  const commentsSeen = patch.seenComments ? Array.from(new Set([...normalized.commentsSeen, ...patch.seenComments])) : normalized.commentsSeen;

  let epicsSeen = normalized.epicsSeen;
  if (patch.epics !== undefined) {
    const nextEpicsSeen: Record<string, readonly string[]> = {};
    for (const [key, ids] of Object.entries(patch.epics)) {
      nextEpicsSeen[key] = Array.from(new Set([...(normalized.epicsSeen[key] ?? []), ...ids]));
    }
    epicsSeen = nextEpicsSeen;
  }

  const nextWake: StoredWake = {
    ...wake, // preserves the legacy `comment`/`epics` scalars VERBATIM — see this function's own doc comment.
    version: patch.version ?? normalized.version,
    commentsSeen,
    epicsSeen,
  };
  const nextProperty = { ...current, wake: nextWake };
  assertWithinPropertySizeCeiling(projectKey, nextProperty);
  await ops.setProjectProperty(projectKey, PROPERTY_KEY, nextProperty);
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
      observedCommentIds: [],
      observedEpics: [],
      unseenCommentIds: [],
      unseenEpicCommentIds: {},
      watermark: EMPTY_WATERMARK,
    }));

  const resolved: ProjectResource[] = await Promise.all(
    eligible.map(async (p, i): Promise<ProjectResource> => {
      const rootDocId = p.rootDocId;
      const epics = epicsByProject.get(p.key) ?? [];
      // One getIssueComments() call per IN-REVIEW epic only (usually zero
      // epics, per this file's own call-count budget) — deliberately not
      // batched (there is no bulk comments read), and deliberately not
      // `updated` (see ProjectWatermark.epicsSeen's doc comment for the
      // measured label-churn reason). The SAME reader `check_in`
      // (src/tools/defs.ts) uses to watermark this same axis — see
      // `getIssueComments`'s own doc comment on AtlassianOps.
      const observedEpics: ProjectEpic[] = await Promise.all(
        epics.map(async (epic): Promise<ProjectEpic> => ({ key: epic.key, commentIds: (await deps.ops.getIssueComments(epic.key)).results.map((c) => c.id) })),
      );
      // BUTCHR-227: the migration adapter runs HERE, at the one read path
      // this ticket's own doc comment on `normalizeWake` names — a
      // pre-migration project's stored scalar is turned into a one-member
      // seen set, never treated as a threshold. See that function's own
      // doc comment for the reasoning this module must reproduce in its PR.
      const watermark = normalizeWake(p.wake);
      const observedCommentIds = commentsByProject[i]!.results.map((c) => c.id);
      // THE CLASSIFICATION SEAM (BUTCHR-227) — computed once, here, where
      // both the observation and the watermark are in hand, and reused by
      // both `projectVerdict` (the wake decision) and a future BUTCHR-208
      // sender-class filter, rather than recomputed in each: see
      // `ProjectResource.unseenCommentIds`'s own doc comment for why this
      // must stay a SEPARATE field from `observedCommentIds`, never folded
      // into it.
      const unseenCommentIds = unseenIds(observedCommentIds, watermark.commentsSeen);
      const unseenEpicCommentIds: Record<string, readonly string[]> = {};
      for (const e of observedEpics) {
        unseenEpicCommentIds[e.key] = unseenIds(e.commentIds, watermark.epicsSeen[e.key] ?? []);
      }
      return {
        key: p.key,
        name: p.name,
        eligible: true,
        rootDocId,
        observedVersion: versions[rootDocId] ?? null,
        observedCommentIds,
        observedEpics,
        unseenCommentIds,
        unseenEpicCommentIds,
        watermark,
      };
    }),
  );

  return [...resolved, ...ineligible];
}

/** SET equality, not array/reference equality — see `changed`'s own doc comment for why this must not degrade to comparing array identity or order. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

/**
 * Structural diff over OBSERVED fields only (never `watermark`, which the
 * SAME poll's own I/O just re-read and which advancing on its own is not an
 * "event") — mirrors the issue tier's `changedKeys` in shape and purpose:
 * an unchanged poll produces zero notify-stage work, so a project that is
 * genuinely `active` every poll (watermark never advanced — see this
 * file's top comment on the stated gap) is not re-nudged every single poll,
 * only when something about it actually moved since last time.
 *
 * BUTCHR-227: compares `observedCommentIds`/`commentIds` as SETS
 * (`sameIdSet`), not scalars and not array equality. This is deliberate,
 * not incidental — `getPageComments` requests no `sort` (see that op's own
 * doc comment on `AtlassianOps`), so two polls observing the exact same
 * underlying comments can return them in a DIFFERENT array order with
 * nothing having actually changed. A comparison that silently degraded to
 * array-order or reference equality here would manufacture a spurious
 * "changed" event, and therefore a spurious nudge, on every such poll —
 * covered by this file's own test suite with a fixture that holds the
 * same ids in two different orders and asserts `changed` reports `false`.
 */
function changed(prev: ProjectResource, next: ProjectResource): boolean {
  if (prev.eligible !== next.eligible) return true;
  if (prev.observedVersion !== next.observedVersion) return true;
  if (!sameIdSet(prev.observedCommentIds, next.observedCommentIds)) return true;
  if (prev.observedEpics.length !== next.observedEpics.length) return true;
  const prevEpics = new Map(prev.observedEpics.map((e) => [e.key, e.commentIds]));
  return next.observedEpics.some((e) => {
    const before = prevEpics.get(e.key);
    return before === undefined || !sameIdSet(before, e.commentIds);
  });
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
