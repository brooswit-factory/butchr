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
 * A type ALIAS, not an interface, on purpose: today `AgentDashboardRow` is
 * the only member, but writing this as a union (of one, for now) rather than
 * an interface means BUTCHR-288 adding `AgentDashboardRow | WithheldDashboardRow`
 * later is a pure addition to this line — `AgentDashboardRow` itself never
 * changes shape, and existing code that already narrows on `kind` (or never
 * needed to, because only one kind existed) keeps compiling. Consumers
 * should still match on `row.kind` rather than assuming `AgentDashboardRow`
 * is the only possibility, so that a future second member is a compile-time
 * prompt to handle it, not a silent gap.
 */
export type DashboardRow = AgentDashboardRow;

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
 */
export type DashboardResponse = { checked: true; rows: DashboardRow[] } | { checked: false; declinedAt: string; rows: DashboardRow[] };

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
