/**
 * BUTCHR-269: builds `/dashboard`'s rows — one per agent this daemon runs,
 * from data already in hand (the falsifier the ticket ran: `agent.list()`
 * plus the issue loop's own retained `issuetype`/`summary` map).
 *
 * PURE BY DESIGN, NO FETCH OF ITS OWN: `buildDashboardRows` takes an already-
 * fetched `agents` array rather than calling `herdr.agent.list()` itself.
 * The fetch happens exactly once per poll, tee'd into `createLabelSync`'s
 * existing `agentStatuses` provider in `src/daemon/index.ts` — the SAME
 * poll-driven call already wired to the coverage tracker, per the ticket's
 * own ruling (BUTCHR-263) that a request-time fetch would make
 * `lastConfirmedAt` vacuous (always "now") and would feed the status-floor
 * tracker only when someone loads the page, laundering a multi-day stall
 * into a floor that starts at the first view. The result of that one fetch
 * is stored as a snapshot in `src/daemon/index.ts` and served as-is by the
 * `/dashboard` route — no I/O on the request path.
 *
 * "COULD NOT CHECK" — case 1, the whole-response one (the `agent.list()`
 * read itself failing), is therefore also NOT this module's concern: only
 * the caller in `src/daemon/index.ts` knows whether this poll's fetch
 * succeeded, and only the caller holds the previous snapshot that a failed
 * poll must not silently erase (stale rows, each still carrying its own real
 * — now older — `confirmedAt`, plus a decline marker, rather than either
 * discarding them or re-serving them as freshly confirmed). This module only
 * ever builds the SUCCESS half: `DashboardRow[]` from an `agents` array that
 * was, by construction, just fetched successfully.
 *
 * This module IS responsible for the two per-ROW "could not check" cases,
 * neither of which is about the fetch:
 *   2. A row's `issuetype` is unavailable (a fresh daemon before its first
 *      search lands, or a key that dropped out of the search while its
 *      agent is still winding down) — `tier.issuetype` is
 *      `{checked: false, declinedAt}`, NEVER a guessed task/story/epic
 *      default.
 *   3. A row's status floor is unknown because `StatusFloorTracker` has
 *      never seen it — see that module's `exact: false` for how THIS case
 *      is represented (a fresh floor, distinct from a genuine zero).
 *
 * `DASHBOARD_DETECTOR` is defined here (the name this endpoint registers
 * under in `src/daemon/coverage.ts`) but the `recordChecked`/`recordDeclined`
 * calls themselves live in `src/daemon/index.ts`, next to the fetch they
 * describe — same discipline `src/labels/sync.ts` uses for its own "stalled"
 * dimension (recorded where the fetch's outcome is actually known, not
 * inside a module that never sees it).
 */
import { isProjectId } from "../resources/id.js";
import { issueOfAgentName } from "./herd.js";
import { StatusFloorTracker, type StatusFloor } from "./status-floor.js";
import type { AdmissionCensus } from "./admission.js";

/** The name this endpoint registers itself under in the shared coverage tracker (src/daemon/coverage.ts) — see this module's own header for why the recordChecked/recordDeclined calls themselves live in src/daemon/index.ts instead. */
export const DASHBOARD_DETECTOR = "dashboard";

/** What the issue loop's retained per-key map (src/daemon/index.ts) must supply for a row's tier to be fully known. */
export interface IssueMeta {
  summary: string;
  issuetype: string;
}

/** `tier`'s epic/story/task half — `checked: false` must never be defaulted to a guessed value (see this module's header, case 2). */
export type IssuetypeField = { checked: true; value: string } | { checked: false; declinedAt: string };

/** Project vs issue is structural and free (`isProjectId`/`isIssueKey`, mutually exclusive by construction); a project row has no issuetype to know or decline. */
export type TierField = { kind: "project" } | { kind: "issue"; issuetype: IssuetypeField };

/**
 * Row-kind discriminator. Today there is exactly one kind: "agent", one row
 * per agent this daemon runs. BUTCHR-288 (shelved until this endpoint
 * merges) is expected to add a "withheld" kind — one row per ticket the
 * admission cap is withholding, which has a `resourceKey` and `tier` but NO
 * agent, and therefore no `pane` and no `agentStatus`. Because those two
 * fields live only on the "agent" variant below rather than on a shared base
 * every kind must satisfy, adding "withheld" is an ADDITIVE union member,
 * not a redefinition of what every existing field means — a future withheld
 * row structurally omits `pane`/`agentStatus` rather than needing a sentinel
 * (`""`, `"unknown"` — `"unknown"` is already a real `agentStatus` value and
 * means something else) to satisfy a required field.
 *
 * This is also where this row type's "not applicable" lives, and it is
 * DELIBERATELY a different mechanism from `IssuetypeField`'s checked/declined
 * below: a withheld row's missing `pane` is not "could not check" — nothing
 * failed, nothing was unavailable, there is simply no agent to have one. That
 * is a third thing, distinct from both "known" and "declined", and it is
 * represented by the field being structurally absent from that row kind
 * entirely — never by folding it into checked/declined. A consumer that
 * recognizes only "known" and "declined" for a field's absence would render a
 * perfectly healthy withheld row as a monitoring failure (this story's own
 * founding error, one level out). Keep the two concepts textually and
 * structurally separate; do not widen checked/declined into a home for both.
 */
export interface AgentDashboardRow {
  kind: "agent";
  resourceKey: string;
  tier: TierField;
  /** Raw `AgentInfo.agent_status` — the SDK-pinned `"idle" | "working" | "blocked" | "done" | "unknown"` domain, served as-is rather than remapped through labels/plan.ts's `ObservedAgentLabel` (a different consumer's own vocabulary). */
  agentStatus: string;
  pane: string;
  timeInStatus: StatusFloor;
  /** ISO timestamp of the poll that produced this row — "every row says when its data was last confirmed" (this ticket's DoD #4). Every row from the SAME successful poll shares one value; carried per-row (not just once at the top level) because that is the literal claim the DoD makes about EVERY row. On a declined poll (src/daemon/index.ts) a row's `confirmedAt` is deliberately left unchanged — a stale row must keep telling the truth about when it was last actually confirmed, not be laundered into looking fresh. */
  confirmedAt: string;
}

/**
 * BUTCHR-332: one row per ticket the fleet-wide admission cap is currently
 * withholding (src/agents/admission.ts) — a `resourceKey` and `tier`, same
 * semantics as an agent row, but structurally NO `pane` and NO `agentStatus`:
 * there is no agent for this ticket, so there is nothing for those fields to
 * report. See `DashboardRow`'s own doc comment for why that absence is a
 * THIRD thing, distinct from "known" and from `IssuetypeField`'s
 * checked/declined "could not check" — and why `agentFields` below exists
 * beside the structural absence rather than instead of it.
 */
export interface WithheldDashboardRow {
  kind: "withheld";
  resourceKey: string;
  tier: TierField;
  /** Which admission-census source (e.g. the issue or project tier) produced this row — see src/agents/admission.ts's `AdmissionCensusBucket`. Lets a consumer (and a test) tie a row to the specific census that produced it, which is what makes "only the project tier's rows went could-not-check" checkable rather than merely asserted. */
  source: string;
  /** A floor on how long this ticket has been withheld — reuses `StatusFloorTracker`/`StatusFloor` verbatim (same provenance/`exact` contract as an agent row's `timeInStatus`; see that field's own doc comment). Never the admission controller's own internal poll-count wait ledger, which is counted in polls across two differently-paced tiers and is not a time. */
  waiting: StatusFloor;
  /** ISO timestamp of the POLL THAT OBSERVED this ticket withheld — its census bucket's own `confirmedAt` (src/agents/admission.ts), not the dashboard poll's clock. Never re-stamped by a dashboard poll that merely re-read the same bucket, and never re-stamped by `snapshot()`. */
  confirmedAt: string;
  /**
   * The explicit positive marker `DashboardRow`'s own doc comment calls
   * for: structural absence of `pane`/`agentStatus` on this variant is
   * necessary but not sufficient for a JSON consumer, who cannot otherwise
   * tell "absent because not applicable" from "absent because the producer
   * broke". This field's shape is deliberately NOT `IssuetypeField`'s
   * `{checked: false, declinedAt}` — a reader must be able to tell the two
   * apart without reading this ticket.
   */
  agentFields: { applicable: false; reason: string };
}

/**
 * `WithheldDashboardRow`'s `agentFields` value — one constant, reused
 * everywhere a withheld row is built, so every withheld row states the
 * identical reason rather than each call site inventing its own wording.
 */
const WITHHELD_AGENT_FIELDS = { applicable: false as const, reason: "no agent: withheld by the admission cap" };

/**
 * `AgentDashboardRow | WithheldDashboardRow` (BUTCHR-332) — a pure addition
 * to what was a one-member alias, exactly as this type's own prior doc
 * comment anticipated. `AgentDashboardRow` itself does not change shape.
 * Consumers should match on `row.kind` rather than assuming one member is
 * the only possibility, so a future third member is a compile-time prompt
 * to handle it, not a silent gap.
 */
export type DashboardRow = AgentDashboardRow | WithheldDashboardRow;

/**
 * The whole-response shape. Both members carry `rows` (never split into a
 * `rows`-less decline shape): the caller (src/daemon/index.ts) preserves the
 * last known-good rows across a declined poll rather than discarding them —
 * see this module's header for why that choice belongs to the caller, not
 * here. `checked` is the signal a reader must act on: `true` means this
 * poll's `agent.list()` succeeded (an empty `rows` here is a genuine finding
 * — "this daemon runs no agents"); `false` means it did not, and `rows` (if
 * non-empty) is left over from a PRIOR successful poll — each row's own
 * `confirmedAt` says exactly how stale.
 *
 * BUTCHR-308: the `checked: true` shape carries its OWN `confirmedAt` (the
 * poll that produced it), not just each row's. A genuinely empty fleet
 * (`rows: []`) has no row to carry a time at all — without a response-level
 * timestamp, "checked: this daemon runs nothing" and "checked: this daemon
 * ran nothing, as of some unknowable time" collapse into the same shape,
 * reopening this story's founding distinction (BUTCHR-116) for exactly the
 * response that has zero rows to leak it through. Every row from the same
 * poll already shares one `confirmedAt` value (see `AgentDashboardRow`); this
 * is that same value, lifted to the top so it survives when `rows` is empty.
 * The declined shape is deliberately NOT given the same field — it already
 * carries `declinedAt`, which is its own answer to "as of when".
 */
export type DashboardResponse =
  | { checked: true; confirmedAt: string; rows: DashboardRow[]; admission: AdmissionView }
  | { checked: false; declinedAt: string; rows: DashboardRow[]; admission: AdmissionView };

/** One source's residency-census state, as the response reports it — see `AdmissionCensusBucket` (src/agents/admission.ts), whose `withheld`/`source` are not repeated here (a consumer reads those off the withheld rows themselves via `WithheldDashboardRow.source`, not off this field). */
export type AdmissionCensusField = { checked: true; confirmedAt: string } | { checked: false; declinedAt: string; reason: string };

/**
 * BUTCHR-332: the admission view carried on BOTH `DashboardResponse`
 * variants (additive — no existing field changes meaning). `sources` is ONE
 * ENTRY PER SOURCE, deliberately with no single aggregate "is the census
 * fine" boolean anywhere on this shape — see `AdmissionCensus`'s own doc
 * comment (src/agents/admission.ts) for why a single flag would let one
 * source's trusted bucket vouch for a different, failed or never-reported
 * one. Note the two different `checked` flags in play and keep them
 * distinguishable: `DashboardResponse.checked` is about THIS poll's
 * `agent.list()`; a source's own `census.checked` here is about THAT tier's
 * residency census. They are independent — either can fail alone.
 */
export interface AdmissionView {
  /** Same value `/health` already reads via `AdmissionSnapshot.cap` — not a second source. */
  cap: number;
  /** Same value `/health` already reads via `AdmissionSnapshot.residency` — not a second source. */
  residency: number | null;
  sources: readonly { source: string; census: AdmissionCensusField }[];
}

/** `AdmissionCensus` (src/agents/admission.ts) → this module's own `AdmissionView` — the one place that translation happens, so `createDashboardFeed`/`initialDashboardSnapshot` below never duplicate it. */
export function buildAdmissionView(census: AdmissionCensus): AdmissionView {
  return {
    cap: census.cap,
    residency: census.residency,
    sources: census.buckets.map((b) => ({
      source: b.source,
      census: b.checked ? { checked: true as const, confirmedAt: b.confirmedAt } : { checked: false as const, declinedAt: b.declinedAt, reason: b.reason },
    })),
  };
}

/** The subset of `AgentInfo` this module actually reads — kept narrow so a test fixture doesn't have to fabricate herdr's full shape. */
export interface DashboardAgent {
  name?: string | null;
  agent_status: string;
  pane_id: string;
}

export interface BuildDashboardRowsDeps {
  now: () => number;
  /** The issue loop's retained per-key metadata (src/daemon/index.ts) — `undefined` means genuinely unavailable, never "no tier". */
  issueMeta: (key: string) => IssueMeta | undefined;
  tracker: StatusFloorTracker;
}

/**
 * Builds one poll's worth of dashboard rows from an already-fetched `agents`
 * array. Pure and synchronous — no I/O, never throws on its own (the fetch
 * that could fail already happened, in the caller, before this runs).
 */
export function buildDashboardRows(agents: readonly DashboardAgent[], deps: BuildDashboardRowsDeps): DashboardRow[] {
  const confirmedAt = new Date(deps.now()).toISOString();

  const resolved: { agent: DashboardAgent; resourceKey: string }[] = [];
  for (const agent of agents) {
    const resourceKey = issueOfAgentName(agent.name);
    if (resourceKey) resolved.push({ agent, resourceKey });
  }
  // Same discipline as FrozenAsleepTracker.forgetMissing: an id absent from
  // THIS poll's set drops its floor, so a later reappearance starts fresh
  // (inexact) rather than inheriting a stale one from an unrelated episode.
  deps.tracker.forgetMissing(new Set(resolved.map((r) => r.resourceKey)));

  return resolved.map(({ agent, resourceKey }) => ({
    kind: "agent" as const,
    resourceKey,
    tier: buildTier(resourceKey, deps.issueMeta, confirmedAt),
    agentStatus: agent.agent_status,
    pane: agent.pane_id,
    timeInStatus: deps.tracker.observe(resourceKey, agent.agent_status),
    confirmedAt,
  }));
}

function buildTier(resourceKey: string, issueMeta: (key: string) => IssueMeta | undefined, declinedAt: string): TierField {
  if (isProjectId(resourceKey)) return { kind: "project" };
  const meta = issueMeta(resourceKey);
  return { kind: "issue", issuetype: meta ? { checked: true, value: meta.issuetype } : { checked: false, declinedAt } };
}

/** Per-source withheld rows, as retained across polls — see `updateWithheldRows`. */
export type WithheldRowsBySource = ReadonlyMap<string, readonly WithheldDashboardRow[]>;

export interface UpdateWithheldRowsDeps {
  /** Same per-key metadata `buildDashboardRows`/`buildTier` already read — `undefined` means genuinely unavailable, never "no tier". */
  issueMeta: (key: string) => IssueMeta | undefined;
  /** A SECOND, dedicated `StatusFloorTracker` instance — never the agent rows' own `tracker` (that one is keyed by `agentStatus` transitions; this one by "withheld" duration, and sharing one would let each `forgetMissing` evict the other's entries). */
  tracker: StatusFloorTracker;
  /** Resource keys with an agent row THIS poll — agent wins (see `DashboardRow`'s own doc comment): a key here is dropped from every source's withheld rows, freshly-observed or carried forward alike. */
  agentKeys: ReadonlySet<string>;
}

/**
 * BUTCHR-332: the per-source "carry forward on decline" decision — what
 * `/dashboard`'s withheld rows look like after a poll's admission census
 * reports each source checked or declined. Pure and synchronous, driven
 * directly by `test/unit/dashboard.test.ts` against the real
 * `AdmissionCensus` shape, same discipline `createDashboardFeed`'s own
 * could-not-check decision already follows (BUTCHR-308).
 *
 * For a bucket that reported `checked: true` THIS call, that source's rows
 * are rebuilt fresh from `bucket.withheld` (each carrying `bucket.confirmedAt`
 * — the poll that observed it, never re-stamped by a later read). For a
 * bucket that `checked: false` (threw, untrusted, or never-reported), that
 * source's entry in `prior` is carried forward BYTE-IDENTICAL — never
 * dropped, never re-stamped, never invented — which is exactly what makes a
 * decline in ONE source leave every OTHER source's rows untouched (the
 * per-source isolation the epic's own correction demands).
 *
 * "Agent wins" (row identity) is enforced across BOTH freshly-built and
 * carried-forward rows alike: a key admitted since a source last reported is
 * removed from that source's retained rows too, not only from a fresh
 * rebuild — the census read that produced a carried-forward row is from an
 * EARLIER poll and is the staler of the two by construction.
 *
 * `tracker.forgetMissing` runs once, over the FULL retained withheld set
 * (fresh ∪ carried-forward, post agent-wins filtering) — never only the
 * freshly-observed subset, or a carried-forward row's floor would be evicted
 * merely because ITS OWN source didn't report this poll, surfacing as a
 * spurious "fresh, inexact" floor the moment that source recovers even
 * though nothing about that ticket's own wait actually changed.
 */
export function updateWithheldRows(census: AdmissionCensus, prior: WithheldRowsBySource, deps: UpdateWithheldRowsDeps): WithheldRowsBySource {
  const next = new Map<string, readonly WithheldDashboardRow[]>(prior);
  for (const bucket of census.buckets) {
    if (!bucket.checked) continue; // could-not-check: leave this source's prior rows exactly as they are
    const rows: WithheldDashboardRow[] = [];
    for (const key of bucket.withheld) {
      if (deps.agentKeys.has(key)) continue; // agent wins — this key has a live agent row this same poll
      rows.push({
        kind: "withheld",
        resourceKey: key,
        tier: buildTier(key, deps.issueMeta, bucket.confirmedAt),
        source: bucket.source,
        waiting: deps.tracker.observe(key, "withheld"),
        confirmedAt: bucket.confirmedAt,
        agentFields: WITHHELD_AGENT_FIELDS,
      });
    }
    next.set(bucket.source, rows);
  }
  // Agent wins even for a row carried forward from a DECLINED source's prior
  // report — that source doesn't know this poll's agent list at all, but the
  // agent list is independently authoritative regardless of which poll last
  // refreshed a given source's own census.
  for (const [source, rows] of next) {
    if (rows.some((r) => deps.agentKeys.has(r.resourceKey))) next.set(source, rows.filter((r) => !deps.agentKeys.has(r.resourceKey)));
  }
  const stillWithheld = new Set<string>();
  for (const rows of next.values()) for (const r of rows) stillWithheld.add(r.resourceKey);
  deps.tracker.forgetMissing(stillWithheld);
  return next;
}

/**
 * BUTCHR-308: the "could not check" decision — what `/dashboard`'s snapshot
 * looks like after a poll succeeds or fails — moved OUT of
 * `src/daemon/index.ts` and in here, next to `buildDashboardRows`, so it is
 * unit-testable at all. Before this ticket the decision lived inline inside
 * `createLabelSync`'s `agentStatuses` provider in `index.ts`, a module no
 * unit test in this repo imports (its own generated load test only
 * transpiles it) — so a mutation that discarded the prior rows on decline,
 * or one that laundered a decline into `checked: true`, passed the whole
 * suite unnoticed. `index.ts` keeps the fetch itself (only it knows whether
 * `agent.list()` succeeded this poll, and only it also needs the raw
 * `agents` array to feed `createLabelSync`'s own status map — see this
 * module's header for why a second fetch here would violate "no new I/O")
 * and keeps `coverage.recordChecked`/`recordDeclined` (per this module's own
 * header, recorded where the fetch's outcome is actually known). Everything
 * else — carry the prior rows forward on decline, stamp a fresh
 * `confirmedAt`/`declinedAt` from `deps.now`, build fresh rows on success —
 * lives here instead, where `test/unit/dashboard.test.ts` can drive it
 * directly against the real function.
 */
export interface DashboardFeed {
  /**
   * Runs one poll: calls `list()` exactly once. On success, replaces the
   * snapshot with `{checked: true, confirmedAt, rows}` (rows built by
   * `buildDashboardRows`, sharing that SAME `confirmedAt`) and returns the
   * raw `agents` array so the caller can reuse it (its own status map for
   * `createLabelSync`) without a second fetch. On failure, the snapshot
   * flips to `{checked: false, declinedAt, rows}` with `rows` carried
   * forward BYTE-IDENTICAL from whatever the snapshot held before this call
   * (no row's own `confirmedAt` moves) — and the error is rethrown. This
   * feed never swallows a failed poll; it only decides what the snapshot
   * looks like while that failure propagates to the caller's own poll loop,
   * which is what actually aborts the poll and produces its `loop error:`
   * line (see `index.ts`'s own comment on that call site).
   */
  poll(list: () => Promise<{ agents: readonly DashboardAgent[] }>): Promise<readonly DashboardAgent[]>;
  /** The current snapshot. No I/O of its own: never calls `list`, never advances `confirmedAt` — a request-time read is exactly that, a read. */
  snapshot(): DashboardResponse;
  /**
   * BUTCHR-354: call at the very start of each fetch tick — loop.ts's own
   * step 1 (`resourceType.discovery.search()`), before `reconcileNow`/
   * `related`/`syncLabels` ever run — to reset this tick's "already
   * touched" bookkeeping, which `declineUpstream` below reads so it never
   * double-records the one poll whose OWN `poll()` call (via `syncLabels`'s
   * `agentStatuses` dep, step 4) already recorded its own outcome. Safe to
   * call more than once per tick (e.g. `related`'s own secondary `search()`
   * call, src/resources/issue.ts's `createRelated`, which runs AFTER step 1
   * but still strictly BEFORE step 4) — this is a plain reset, not a
   * counter, so an extra call before `poll`/`declineUpstream` ever run this
   * tick is a no-op by construction.
   */
  beginPoll(): void;
  /**
   * BUTCHR-354: the "could not check" decision for a poll that never
   * reached THIS feed's own fetch at all — an upstream rejection
   * (`search`/`reconcileNow`/`related`, loop.ts steps 1-3, aborting the
   * fetch stage before it ever reaches `syncLabels`, so `poll` above is
   * never called this tick). Flips the snapshot to `{checked: false,
   * declinedAt}` the same way `poll`'s own catch branch does —
   * `declinedAt` from `deps.now`, `rows`/`admission` carried forward
   * BYTE-IDENTICAL from whatever the snapshot held before this call, same
   * "stale rows, honestly labeled" ruling `poll` already follows.
   *
   * A NO-OP whenever `poll` already ran THIS tick (successfully or not) —
   * `poll` already decided this tick's snapshot, and, on its own decline
   * path, already told its caller to record its own coverage decline;
   * calling this too would double-count the ONE failure mode
   * (`agent.list()` itself rejecting, step 4) that already counted
   * correctly before this ticket (BUTCHR-308). Returns whether it actually
   * recorded a decline, so the caller knows whether to ALSO call its own
   * `coverage.recordDeclined` — never call that unconditionally alongside
   * this, or the double-count this method exists to prevent reappears one
   * layer out, in the caller instead of here.
   *
   * EVIDENCE RANKING (epic rule 6): after this fires, the response carries
   * a LIVE per-poll observation (`checked: false`, `declinedAt` — THIS
   * poll's own answer to "can we currently confirm anything") alongside
   * whatever CARRIED-FORWARD rows survive from an earlier successful poll,
   * each still stamped with ITS OWN, now-older, `confirmedAt`. The two
   * answer different questions and neither is promoted to answer the
   * other's: the response-level `checked`/`declinedAt` outranks every row's
   * `confirmedAt` for "is this view current right now" — a fresh-looking
   * row timestamp must never be read as current when the response-level
   * flag says otherwise. Conversely, a row's own `confirmedAt` outranks the
   * response-level `declinedAt` for "when was THIS row's content last
   * actually gathered" — `declinedAt` only says when the check failed, and
   * never stands in for a row's own provenance.
   */
  declineUpstream(): boolean;
}

/**
 * `checked: false` with no rows and no history — the correct answer BEFORE
 * the first poll has ever run, not "fleet empty" (this endpoint's whole
 * reason to exist: those two must never collapse into one shape). Exported
 * so both `createDashboardFeed`'s own initial state and any caller that
 * needs to reason about "never polled yet" read the same literal.
 *
 * BUTCHR-332: takes the initial `AdmissionCensus` too (every declared source
 * pre-seeded `checked: false, reason: "never-reported"` at construction —
 * see `AdmissionControllerDeps.sources`), so the admission view is ALSO
 * "could not check" before the first poll, on the identical terms the rest
 * of this response already uses — never a vacuous "checked, nothing
 * withheld" just because no source has reported yet (mutations 11/12 on the
 * ticket).
 */
export function initialDashboardSnapshot(now: () => number, census: AdmissionCensus): DashboardResponse {
  return { checked: false, declinedAt: new Date(now()).toISOString(), rows: [], admission: buildAdmissionView(census) };
}

export interface CreateDashboardFeedDeps extends BuildDashboardRowsDeps {
  /** BUTCHR-332: synchronous read of the current per-source admission census (src/agents/admission.ts) — reads state the poll that just ran (via `reconcileNow`'s `opts.admission`) already recorded; never a fresh call, never new I/O. */
  admission: () => AdmissionCensus;
  /** BUTCHR-332: a SECOND, dedicated `StatusFloorTracker` instance for the withheld set — see `UpdateWithheldRowsDeps.tracker`'s own doc comment for why this must not be the agent rows' `tracker` above. */
  withheldTracker: StatusFloorTracker;
}

export function createDashboardFeed(deps: CreateDashboardFeedDeps): DashboardFeed {
  let current: DashboardResponse = initialDashboardSnapshot(deps.now, deps.admission());
  // BUTCHR-332: retained across polls — see `updateWithheldRows`'s own doc
  // comment for why a per-source decline must carry forward exactly this
  // state rather than being recomputed from scratch each poll.
  let withheldRowsBySource: WithheldRowsBySource = new Map();
  // BUTCHR-354: tick-scoped, reset by `beginPoll` — see `DashboardFeed.declineUpstream`'s
  // own doc comment for the double-recording hazard this guards against.
  let touchedThisTick = false;
  return {
    snapshot: () => current,
    beginPoll() {
      touchedThisTick = false;
    },
    declineUpstream() {
      if (touchedThisTick) return false;
      touchedThisTick = true;
      current = { checked: false, declinedAt: new Date(deps.now()).toISOString(), rows: current.rows, admission: current.admission };
      return true;
    },
    async poll(list) {
      touchedThisTick = true;
      let agents: readonly DashboardAgent[];
      try {
        ({ agents } = await list());
      } catch (e) {
        // Stale rows, honestly labeled, beat either discarding them or
        // re-serving them as freshly confirmed (the ticket's own ruling on
        // this exact case) — so `rows` (agent AND withheld alike) carries
        // forward unchanged; only the top-level `checked`/`declinedAt` move,
        // and no row's own `confirmedAt` is touched. `admission` also carries
        // forward unchanged — this failure is agent.list()'s, not the
        // admission census's, and `deps.admission()` is deliberately not
        // even called on this path.
        current = { checked: false, declinedAt: new Date(deps.now()).toISOString(), rows: current.rows, admission: current.admission };
        throw e;
      }
      // Captured once so the response-level `confirmedAt` and every row's
      // own `confirmedAt` (built from the SAME clock read, via the `now: ()
      // => nowMs` override below) are the literal same value, not merely two
      // separate reads of a clock that could in principle disagree.
      const nowMs = deps.now();
      const agentRows = buildDashboardRows(agents, { ...deps, now: () => nowMs });
      const agentKeys = new Set(agentRows.map((r) => r.resourceKey));
      const census = deps.admission();
      withheldRowsBySource = updateWithheldRows(census, withheldRowsBySource, {
        issueMeta: deps.issueMeta,
        tracker: deps.withheldTracker,
        agentKeys,
      });
      const withheldRows = [...withheldRowsBySource.values()].flat();
      current = {
        checked: true,
        confirmedAt: new Date(nowMs).toISOString(),
        rows: [...agentRows, ...withheldRows],
        admission: buildAdmissionView(census),
      };
      return agents;
    },
  };
}
