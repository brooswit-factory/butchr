/**
 * FACTORY-615 (task 3 of the LaunchPad switch, epic FACTORY-427): the
 * REAL main-dashboard view-model — a pure, synchronous adaptation of a
 * `DashboardResponse` (plus the `/health` header info `src/web/dashboard-page.ts`
 * already reads) into plain data every React component below renders
 * directly, never re-deriving. No React, no DOM, no `Date.now()` — `now` and
 * every other time-dependent input are passed in, same discipline
 * `src/web/dashboard-page.ts` itself follows, which this module ports
 * behaviour from (not markup — see that module's own header for why it is a
 * separate, pure module in the first place).
 *
 * THE THREE ABSENCES THIS VIEW-MODEL MUST NEVER CONFLATE (carried forward
 * verbatim from `dashboard-page.ts`'s own framing):
 *   - KNOWN: the value is there.
 *   - COULD NOT CHECK: a read failed, was untrusted, or has never happened —
 *     `cnc: true` somewhere in the relevant view, and the literal words
 *     "could not check" in its text, never styled like a known value.
 *   - NOT APPLICABLE: there is no agent for a withheld row — rendered via
 *     `WithheldRowView.notApplicableReason`, never the `cnc` shape.
 * A single withheld row can carry a could-not-check `tier` AND a
 * not-applicable agent-fields marker at once — see `withheldRowView`.
 */
import { agentRowAnchorId, configAnchorForResourceKey } from "../../../src/agents/config-inventory-links.js";
import type { AdmissionView, AgentDashboardRow, DashboardResponse, TierField, WithheldDashboardRow } from "../../../src/agents/dashboard.js";
import { humanDuration, type StatusFloor } from "../../../src/agents/status-floor.js";
import type { CurrencyReport } from "../../../src/daemon/currency.js";
import { decodeAnyAgentKey } from "../../../src/rules/agent-key.js";

/** The subset of `BuildReport` (src/agents/build-identity.ts) this header actually reads — same narrow shape `dashboard-page.ts`'s own `DashboardBuildInfo` declares, kept independent so a test fixture here never has to fabricate herdr's full shape. */
export interface DashboardBuildInfo {
  sha: string | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  version: string;
}

/** Everything the page header needs — PER-DAEMON, never per-row. `currency` absent means this build carries no `currency` sibling on `/health` at all (an older build); present-but-`checkedAt: null` means it has the field but has never computed a verdict yet. */
export interface DashboardHeaderInfo {
  build: DashboardBuildInfo | null;
  currency?: CurrencyReport;
}

export interface DashboardViewOpts {
  /** Injected clock (ms epoch) — every age in the view-model is computed from this, never from a browser clock or the poll's own receipt time (mutation 5). */
  now: number;
  header: DashboardHeaderInfo;
  terminalLinkHref: (pane: string) => string;
  resourceLinkHref: (resourceKey: string) => string;
  /** Defaults to `/configurations#<anchor>` — same default `dashboard-page.ts`'s own `configLinkHref` carries. */
  configLinkHref?: (anchor: string) => string;
}

/** Sanitizes a dynamic value (herdr's raw `agent_status`) into a safe CSS class token — never trusts it to already be one. */
export function safeClass(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return cleaned || "unknown";
}

function ageText(iso: string, now: number): string {
  return humanDuration(Math.max(0, now - Date.parse(iso)));
}

export interface TierView {
  /** Display text — either the tier kind/issuetype value, or the literal "could not check" (never both meanings in one string). */
  text: string;
  /** True iff this is the could-not-check case (a declined `issuetype`). */
  cnc: boolean;
}

export function tierView(tier: TierField): TierView {
  if (tier.kind === "project") return { text: "project", cnc: false };
  if (tier.issuetype.checked) return { text: tier.issuetype.value, cnc: false };
  return { text: "could not check", cnc: true };
}

export interface FloorView {
  /** "6d 3h 12m", or "at least 6d 3h 12m" when `exact` is false — the prefix lives IN the text itself (never only a side note) so the big, glanced-at figure never reads as exact when it is only a lower bound. */
  text: string;
  exact: boolean;
  title: string;
  /** Present only when `!exact` — "(since daemon start — this tracker never witnessed the true start)". */
  inexactNote: string | null;
}

/**
 * The time-in-status floor — recomputed against `now` (this render's own
 * clock) from the floor's ANCHOR (`sinceMs`), rather than trusting
 * `floor.humanDuration` verbatim, which was baked in at POLL time and would
 * otherwise sit frozen between the hook's own 5s polls.
 */
export function floorView(floor: StatusFloor, now: number, label: string): FloorView {
  const elapsed = humanDuration(Math.max(0, now - floor.sinceMs));
  return {
    text: floor.exact ? elapsed : `at least ${elapsed}`,
    exact: floor.exact,
    title: `${label} since ${floor.since}`,
    inexactNote: floor.exact ? null : "(since daemon start — this tracker never witnessed the true start)",
  };
}

export interface FreshnessView {
  text: string;
  stale: boolean;
  title: string;
}

/** `stale` (the RESPONSE's or SOURCE's own `checked === false`) changes both the wording and the class a consumer should apply: a carried-forward row must read "at least X, as of <its own confirmedAt>" and never look like a fresh, current confirmation. */
export function freshnessView(iso: string, now: number, stale: boolean, verb: string): FreshnessView {
  const age = ageText(iso, now);
  if (stale) return { text: `STALE — at least ${age} old, as of ${iso}`, stale: true, title: iso };
  return { text: `${verb} ${age} ago`, stale: false, title: iso };
}

/**
 * FACTORY-408: the visible row label — the bare provider-native resource id
 * a person actually reads (e.g. `FACTORY-68`, never `jira-work:ruleId:FACTORY-68`).
 * A query-level agent renders `<resourceProvider>:<ruleId> (query)` instead:
 * readable, and distinct from an ordinary bare resource id. `null` (nothing
 * this daemon produces for an owned agent today) falls back to the raw key.
 */
export function displayResourceKey(resourceKey: string): string {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (decoded === null) return resourceKey;
  return decoded.kind === "resource" ? decoded.resourceId : `${decoded.resourceProvider}:${decoded.ruleId} (query)`;
}

/** FACTORY-81: the additive Configurations back-link's href — `null` only when `resourceKey` fails to decode at all (nothing this daemon produces today for an owned agent). */
export function configBackLinkHref(resourceKey: string, opts: Pick<DashboardViewOpts, "configLinkHref">): string | null {
  const anchor = configAnchorForResourceKey(resourceKey);
  if (anchor === null) return null;
  return opts.configLinkHref ? opts.configLinkHref(anchor) : `/configurations#${anchor}`;
}

/** `WithheldRowView.notApplicableReason`'s own label — the NOT-APPLICABLE marker's fixed text, deliberately never the could-not-check wording (nothing failed; see this module's header). */
export const NOT_APPLICABLE_LABEL = "no agent — n/a";

export interface AgentRowView {
  kind: "agent";
  anchorId: string;
  displayKey: string;
  resourceKey: string;
  tier: TierView;
  statusClass: string;
  agentStatus: string;
  pane: string;
  floor: FloorView;
  freshness: FreshnessView;
  terminalHref: string;
  resourceHref: string;
  /** `null` means no back-link should render at all (see `configBackLinkHref`). */
  configHref: string | null;
}

function agentRowView(row: AgentDashboardRow, stale: boolean, opts: DashboardViewOpts): AgentRowView {
  return {
    kind: "agent",
    anchorId: agentRowAnchorId(row.resourceKey),
    displayKey: displayResourceKey(row.resourceKey),
    resourceKey: row.resourceKey,
    tier: tierView(row.tier),
    statusClass: safeClass(row.agentStatus),
    agentStatus: row.agentStatus,
    pane: row.pane,
    floor: floorView(row.timeInStatus, opts.now, `in status "${row.agentStatus}"`),
    freshness: freshnessView(row.confirmedAt, opts.now, stale, "confirmed"),
    terminalHref: opts.terminalLinkHref(row.pane),
    resourceHref: opts.resourceLinkHref(row.resourceKey),
    configHref: configBackLinkHref(row.resourceKey, opts),
  };
}

export interface WithheldRowView {
  kind: "withheld";
  resourceKey: string;
  tier: TierView;
  floor: FloorView;
  freshness: FreshnessView;
  notApplicableReason: string;
  resourceHref: string;
  source: string;
}

/**
 * `sourceDeclined`: whether THIS ROW's OWN `source` currently reports
 * `census.checked === false` on `response.admission` (see
 * `buildDashboardViewModel`'s own `declinedSources` set) — never the
 * response-level `checked` flag, which is a DIFFERENT signal. See
 * `dashboard-page.ts`'s own `renderWithheldRow` doc comment for the full
 * reasoning this ports verbatim.
 */
function withheldRowView(row: WithheldDashboardRow, opts: DashboardViewOpts, sourceDeclined: boolean): WithheldRowView {
  return {
    kind: "withheld",
    resourceKey: row.resourceKey,
    tier: tierView(row.tier),
    floor: floorView(row.waiting, opts.now, "withheld"),
    freshness: freshnessView(row.confirmedAt, opts.now, sourceDeclined, "observed"),
    notApplicableReason: row.agentFields.reason,
    resourceHref: opts.resourceLinkHref(row.resourceKey),
    source: row.source,
  };
}

export type DashboardRowView = AgentRowView | WithheldRowView;

export interface AdmissionSourceView {
  source: string;
  checked: boolean;
  text: string;
}

export interface AdmissionViewModel {
  cap: number;
  residencyKnown: boolean;
  residencyText: string;
  sentinelsKnown: boolean;
  sentinelsText: string;
  sources: AdmissionSourceView[];
}

/** The admission panel: cap, residency, and EACH source's census state ON ITS OWN (requirement 4) — deliberately no aggregate "census OK" boolean, mirroring `AdmissionView`'s own doc comment. */
export function admissionView(admission: AdmissionView, now: number): AdmissionViewModel {
  return {
    cap: admission.cap,
    residencyKnown: admission.residency !== null,
    residencyText: admission.residency === null ? "could not check (no trusted census yet)" : String(admission.residency),
    sentinelsKnown: admission.sentinels !== null,
    sentinelsText: admission.sentinels === null ? "?" : String(admission.sentinels),
    sources: admission.sources.map((s) =>
      s.census.checked
        ? { source: s.source, checked: true, text: `${s.source}: checked (confirmed ${ageText(s.census.confirmedAt, now)} ago)` }
        : { source: s.source, checked: false, text: `${s.source}: COULD NOT CHECK — ${s.census.reason} (as of ${ageText(s.census.declinedAt, now)} ago)` },
    ),
  };
}

export interface BuildHeaderViewModel {
  buildText: string;
  /** `null` means no `currency` sibling at all on this build's `/health` (an older build) — render the build line alone. */
  currencyText: string | null;
}

/**
 * Build + currency, PER-DAEMON. NEVER a "red"/error signal, regardless of
 * `verdict.status` — being behind can be deliberate, and this must never
 * turn anything red on its own. `commitsAhead === 0` is the ONLY case that
 * renders "behind by N" — anything else, including `null`, renders as
 * diverged/undetermined (ported verbatim from `dashboard-page.ts`'s own
 * `renderBuildHeader`).
 */
export function buildHeaderView(header: DashboardHeaderInfo, now: number): BuildHeaderViewModel {
  const build = header.build;
  const buildText = build?.sha
    ? `build ${build.sha.slice(0, 8)}${build.shaDirty === true ? " (dirty)" : build.shaDirty === false ? " (clean)" : ""} · version ${build.version}`
    : `build sha unknown${build?.shaUnknownReason ? ` (${build.shaUnknownReason})` : ""}`;

  if (header.currency === undefined) return { buildText, currencyText: null };

  const { checkedAt, verdict } = header.currency;
  const ageStr = checkedAt === null ? "never computed yet" : `checked ${ageText(checkedAt, now)} ago`;
  let verdictText: string;
  if (verdict.status === "current") {
    verdictText = "current";
  } else if (verdict.status === "unknown") {
    verdictText = `could not determine — ${verdict.reason}`;
  } else if (verdict.commitsAhead === 0) {
    verdictText = `behind by ${verdict.commitsBehind ?? "an unknown number of"} commit(s)`;
  } else {
    verdictText = "diverged/undetermined";
  }
  return { buildText, currencyText: `currency: ${verdictText} (${ageStr})` };
}

export interface PageBannerViewModel {
  checked: boolean;
  text: string;
  /** Present only when `checked && rows.length === 0` — the empty-fleet finding is a calm one, distinct from the loud banner below. */
  emptyFindingText: string | null;
  /** Present only when `!checked` — tells the reader how to read whatever rows (if any) are still shown. */
  rowsCarriedNote: string | null;
}

/**
 * The whole-page freshness banner. Keyed SOLELY on `response.checked` —
 * never on `rows.length` — so a genuinely empty fleet (`checked: true,
 * rows: []`) reads as the calm finding it is, while a failed OR never-yet-run
 * poll reads as a loud, unmissable banner (ported verbatim from
 * `dashboard-page.ts`'s own `renderPageBanner`).
 */
export function pageBannerView(response: DashboardResponse, now: number): PageBannerViewModel {
  if (response.checked) {
    return {
      checked: true,
      text: `confirmed ${ageText(response.confirmedAt, now)} ago (at ${response.confirmedAt})`,
      emptyFindingText: response.rows.length === 0 ? "this daemon runs no agents — a genuine finding, not a failure" : null,
      rowsCarriedNote: null,
    };
  }
  const rowsCarriedNote =
    response.rows.length > 0
      ? "Rows below (if any) are carried forward from the last successful poll and may be stale."
      : 'No rows are available — this is NOT the same as "this daemon runs no agents".';
  return {
    checked: false,
    text: `COULD NOT CHECK — this daemon's agent-list read failed, or has never succeeded yet. Declined ${ageText(response.declinedAt, now)} ago (at ${response.declinedAt}).`,
    emptyFindingText: null,
    rowsCarriedNote,
  };
}

export interface DashboardViewModel {
  buildHeader: BuildHeaderViewModel;
  banner: PageBannerViewModel;
  admission: AdmissionViewModel;
  rows: DashboardRowView[];
  configurationsHref: string;
}

/**
 * THE entry point: a pure, synchronous adaptation of a real `/dashboard`
 * response (plus `/health`'s header info) into the finished view-model every
 * component below renders directly. No I/O, no browser clock — every
 * time-dependent value comes from `opts.now` or the response itself.
 */
export function buildDashboardViewModel(response: DashboardResponse, opts: DashboardViewOpts): DashboardViewModel {
  const stale = !response.checked;
  // Which sources currently report `census.checked === false` — a withheld
  // row's OWN freshness badge goes stale in lockstep with its own source's
  // panel entry, never any other source's, and never the whole-response
  // `checked` flag (see `withheldRowView`'s own doc comment).
  const declinedSources = new Set(response.admission.sources.filter((s) => !s.census.checked).map((s) => s.source));
  const rows: DashboardRowView[] = response.rows.map((row) =>
    row.kind === "agent" ? agentRowView(row, stale, opts) : withheldRowView(row, opts, declinedSources.has(row.source)),
  );
  return {
    buildHeader: buildHeaderView(opts.header, opts.now),
    banner: pageBannerView(response, opts.now),
    admission: admissionView(response.admission, opts.now),
    rows,
    configurationsHref: "/configurations",
  };
}
