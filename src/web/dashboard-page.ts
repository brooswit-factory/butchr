/**
 * BUTCHR-339: the butchr dashboard PAGE — a pure, synchronous, server-side
 * render of the real `/dashboard` response (`src/agents/dashboard.ts`), one
 * row per agent plus one per withheld ticket, exactly two links (terminal
 * attach, resource), and no I/O of its own.
 *
 * WHY THIS EXISTS AS A SEPARATE MODULE FROM `src/web/page.ts`: that file is a
 * template string with the rendering logic inside BROWSER JavaScript —
 * nothing in that design can be unit-tested. This module is the opposite:
 * ordinary TypeScript, no `Date.now()`, no fetch, no DOM — `now` and every
 * other time-dependent input are passed in, so `test/unit/dashboard-page.test.ts`
 * can drive it directly against response shapes the real endpoint produces
 * and assert on the returned HTML string.
 *
 * THE THREE ABSENCES THIS RENDER FUNCTION MUST NEVER CONFLATE (the ticket's
 * own framing, repeated here because it is the module's entire job):
 *   - KNOWN: the value is there — rendered plainly, no warning styling.
 *   - COULD NOT CHECK: a read failed, was untrusted, or has never happened —
 *     rendered with the `cnc` class, and the literal words "could not check"
 *     somewhere in its text, never styled like a known value.
 *   - NOT APPLICABLE: there is no agent for a withheld row, so `pane`/
 *     `agentStatus` don't exist to report — rendered with the `na` class and
 *     a dash, never the `cnc` styling (nothing failed).
 * A single withheld row can carry a could-not-check `tier.issuetype` AND a
 * not-applicable `agentFields` marker at once — see `renderWithheldRow`, and
 * the dedicated test in `dashboard-page.test.ts` that builds exactly that
 * row and asserts both classes appear, distinctly.
 *
 * NEVER A JIRA LABEL: this module imports nothing from `src/labels/*` and
 * never will — every status/tier value it renders comes from the
 * `DashboardResponse` it's handed, which is itself fed from herdr's own
 * agent list (see `src/agents/dashboard.ts`'s header). That is deliberate:
 * the simplest way to guarantee mutation 8 ("any status filled from a Jira
 * label") never happens is to make it a missing import, not a discipline.
 */
import type { AdmissionView, DashboardResponse, AgentDashboardRow, WithheldDashboardRow, TierField } from "../agents/dashboard.js";
import type { StatusFloor } from "../agents/status-floor.js";
import { humanDuration } from "../agents/status-floor.js";
import type { CurrencyReport } from "../daemon/currency.js";

/** The subset of `BuildReport` (src/agents/build-identity.ts) this header actually reads — kept narrow so a test fixture doesn't have to fabricate herdr's full shape. */
export interface DashboardBuildInfo {
  sha: string | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  version: string;
}

/** Everything the page HEADER needs — PER-DAEMON, never per-row (see the module header). `currency` absent means this build carries no `currency` sibling on `/health` at all (an older build); present-but-`checkedAt: null` means it has the field but has never computed a verdict yet — the two are different "could not check" shapes and are rendered differently (see `renderHeader`). */
export interface DashboardHeaderInfo {
  build: DashboardBuildInfo | null;
  currency?: CurrencyReport;
}

export interface RenderDashboardOpts {
  /** Injected clock (ms epoch) — every age on the page is computed from this, never from a browser clock or the request time (mutation 5). */
  now: number;
  header: DashboardHeaderInfo;
  /** Builds the terminal-attach link's `href` for a given pane — the route itself (GET /agents/pane/:pane/attach, BUTCHR-267) does the honesty work; this module only needs to know where to point. */
  terminalLinkHref: (pane: string) => string;
  /** Builds the resource-link redirect's `href` for a given resource key — the route itself (GET /resource/:key/open) resolves Jira-vs-Confluence per tier; this module never picks the target itself (mutation 7 is a route-level concern, not a template one — see that route's own tests). */
  resourceLinkHref: (resourceKey: string) => string;
  /** Auto-refresh interval in seconds for the `<meta http-equiv="refresh">` tag. Defaults to 5. */
  refreshSeconds?: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Sanitizes a dynamic value (herdr's raw `agent_status`, a census source name) into a safe CSS class token — never trusts it to already be one. */
function safeClass(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return cleaned || "unknown";
}

/** `now - Date.parse(iso)`, rendered via the SAME `humanDuration` the status-floor fields already use, for one consistent duration vocabulary across the whole page. */
function ageText(iso: string, now: number): string {
  return humanDuration(Math.max(0, now - Date.parse(iso)));
}

interface TierRendering {
  /** Display text — either the tier kind/issuetype value, or the literal "could not check" (never both meanings in one string). */
  text: string;
  /** True iff this is the could-not-check case (a declined `issuetype`) — drives the `cnc` class, kept separate from the text so a caller never has to string-match to know which case this is. */
  cnc: boolean;
}

function renderTier(tier: TierField): TierRendering {
  if (tier.kind === "project") return { text: "project", cnc: false };
  if (tier.issuetype.checked) return { text: tier.issuetype.value, cnc: false };
  return { text: "could not check", cnc: true };
}

/**
 * The time-in-status floor, rendered PROMINENTLY (large text, its own
 * element) per the ticket's own "cheapest thing that would have made the
 * outage visible" requirement — never buried as one more small cell.
 * `exact: false` is marked with an explicit "(since daemon start)" qualifier
 * — mutation 4 is exactly dropping this qualifier or shrinking this element
 * to ordinary cell size.
 *
 * TWO THINGS THIS DOES DELIBERATELY, BOTH FROM BUTCHR-266's OWN REVIEW OF THE
 * FIRST DRAFT:
 *   (1) Recomputes the duration against `now` (this render's own clock) from
 *       the floor's ANCHOR (`sinceMs`), rather than trusting `floor.humanDuration`
 *       verbatim — that field was baked in at POLL time, so a bare display of
 *       it would sit frozen between polls even on the browser's 5s auto-
 *       refresh. This function already has everything needed (`sinceMs`,
 *       `now`) to keep the page's own most-glanced-at number live.
 *   (2) Prefixes "at least " onto the number itself — not only a trailing
 *       note — whenever `exact: false`: the ticket's own review found that a
 *       carried-forward duration must read "at least X", and putting that
 *       qualifier only in a small side note lets the big, glanced-at figure
 *       read as exact when it is only a lower bound. `exact: true` gets NO
 *       prefix, deliberately: this tracker personally witnessed that
 *       transition, so the duration is the genuine answer, not a floor —
 *       prefixing "at least" there would be a false conservatism, not an
 *       honest one.
 */
function renderFloor(floor: StatusFloor, now: number, label: string): string {
  const elapsed = humanDuration(Math.max(0, now - floor.sinceMs));
  const text = floor.exact ? elapsed : `at least ${elapsed}`;
  const inexactNote = floor.exact ? "" : ` <span class="inexact">(since daemon start — this tracker never witnessed the true start)</span>`;
  return `<div class="floor" title="${esc(label)} since ${esc(floor.since)}"><span class="floorval">${esc(text)}</span>${inexactNote}</div>`;
}

/** The page/row freshness badge. `stale` (the RESPONSE's own `checked === false`) changes both the wording and the class: a carried-forward row must read "at least X, as of <its own confirmedAt>" and never look like a fresh, current confirmation (mutation 5's row-level twin, and the ticket's own explicit wording). `extraAttrs`, when given, is spliced verbatim into the opening tag (used by a withheld row to carry its own `data-source`). */
function renderFreshness(iso: string, now: number, stale: boolean, verb: string, extraAttrs = ""): string {
  const age = ageText(iso, now);
  if (stale) {
    return `<span class="conf cnc"${extraAttrs} title="${esc(iso)}">STALE — at least ${esc(age)} old, as of ${esc(iso)}</span>`;
  }
  return `<span class="conf known"${extraAttrs} title="${esc(iso)}">${esc(verb)} ${esc(age)} ago</span>`;
}

function renderAgentRow(row: AgentDashboardRow, stale: boolean, opts: RenderDashboardOpts): string {
  const tier = renderTier(row.tier);
  return (
    `<div class="row agent">` +
    `<span class="key">${esc(row.resourceKey)}</span>` +
    `<span class="tier ${tier.cnc ? "cnc" : "known"}">${tier.cnc ? "COULD NOT CHECK" : esc(tier.text)}</span>` +
    `<span class="st ${safeClass(row.agentStatus)}">${esc(row.agentStatus)}</span>` +
    `<span class="pane">${esc(row.pane)}</span>` +
    renderFloor(row.timeInStatus, opts.now, `in status "${row.agentStatus}"`) +
    renderFreshness(row.confirmedAt, opts.now, stale, "confirmed") +
    `<a class="link" href="${esc(opts.terminalLinkHref(row.pane))}">open terminal</a>` +
    `<a class="link" href="${esc(opts.resourceLinkHref(row.resourceKey))}">resource</a>` +
    `</div>`
  );
}

/** A withheld row's "no agent" marker — the NOT-APPLICABLE case, deliberately never the `cnc` class (nothing failed; see the module header). Rendered alongside — never instead of — a could-not-check `tier`, so a row carrying both is visually distinguishable at a glance (the ticket's own "a single row can carry both" requirement). */
function renderNotApplicable(reason: string): string {
  return `<span class="na" title="${esc(reason)}">no agent — n/a</span>`;
}

/**
 * `sourceDeclined`: whether THIS ROW's OWN `source` currently reports
 * `census.checked === false` on `response.admission` (see `renderDashboard`'s
 * own `declinedSources` set). A withheld row's `confirmedAt` is its census
 * bucket's own observation time — independent of the response-level
 * `checked` flag, which is a DIFFERENT signal (the agent-list read, not this
 * source's census) — so it is NEVER driven by that flag (BUTCHR-266's review
 * confirmed this reasoning). But when the row's OWN source has since
 * declined, `updateWithheldRows` carries that row forward byte-identical
 * (src/agents/dashboard.ts) — so its `confirmedAt` stops advancing while
 * still rendering with calm, "known" styling unless something says
 * otherwise. `sourceDeclined` is that something: it reuses the SAME
 * `data-source` tie the admission panel already renders, so a row's own
 * freshness badge goes STALE in lockstep with its source's own panel entry,
 * never smeared onto rows from a source that is still checking in fine.
 */
function renderWithheldRow(row: WithheldDashboardRow, opts: RenderDashboardOpts, sourceDeclined: boolean): string {
  const tier = renderTier(row.tier);
  return (
    `<div class="row withheld">` +
    `<span class="key">${esc(row.resourceKey)}</span>` +
    `<span class="tier ${tier.cnc ? "cnc" : "known"}">${tier.cnc ? "COULD NOT CHECK" : esc(tier.text)}</span>` +
    `<span class="st waiting">waiting for a slot</span>` +
    renderFloor(row.waiting, opts.now, "withheld") +
    renderFreshness(row.confirmedAt, opts.now, sourceDeclined, "observed", ` data-source="${esc(row.source)}"`) +
    renderNotApplicable(row.agentFields.reason) +
    `<a class="link" href="${esc(opts.resourceLinkHref(row.resourceKey))}">resource</a>` +
    `</div>`
  );
}

/**
 * The admission panel: cap, residency, and EACH source's census state ON ITS
 * OWN (requirement 4). Deliberately no aggregate "census OK" computation
 * here — mirrors `AdmissionView`'s own doc comment: a source's `cnc` class
 * never touches another source's `known` one (mutation 3), which is why each
 * source renders as its own `<div>` carrying its own `data-source`.
 */
function renderAdmission(admission: AdmissionView, now: number): string {
  const residencyHtml =
    admission.residency === null
      ? `<span class="cnc">could not check (no trusted census yet)</span>`
      : `<span class="known">${admission.residency}</span>`;
  const sourceRows = admission.sources
    .map((s) => {
      if (s.census.checked) {
        return `<div class="admsrc known" data-source="${esc(s.source)}">${esc(s.source)}: checked (confirmed ${esc(ageText(s.census.confirmedAt, now))} ago)</div>`;
      }
      return `<div class="admsrc cnc" data-source="${esc(s.source)}">${esc(s.source)}: COULD NOT CHECK — ${esc(s.census.reason)} (as of ${esc(ageText(s.census.declinedAt, now))} ago)</div>`;
    })
    .join("");
  return (
    `<div class="admission">` +
    `<div class="admcap">admission cap: ${admission.cap} · residency: ${residencyHtml}</div>` +
    `<div class="admsources">${sourceRows || '<div class="admsrc none">no census sources declared</div>'}</div>` +
    `</div>`
  );
}

/**
 * Build + currency, PER-DAEMON, shown once in the header (never per-row).
 * NEVER RED, regardless of `verdict.status` — being behind can be
 * deliberate (BUTCHR-276), and the ticket's own rule is that this must never
 * turn anything red on its own; every branch below shares one neutral class.
 * `commitsAhead === 0` is the ONLY case that renders "behind by N" — anything
 * else, including `null`, renders as diverged/undetermined (the field's own
 * documented rule, restated on `RenderDashboardOpts`'s own type import).
 */
function renderBuildHeader(header: DashboardHeaderInfo, now: number): string {
  const build = header.build;
  const buildText = build?.sha
    ? `build ${esc(build.sha.slice(0, 8))}${build.shaDirty === true ? " (dirty)" : build.shaDirty === false ? " (clean)" : ""} · version ${esc(build.version)}`
    : `build sha unknown${build?.shaUnknownReason ? ` (${esc(build.shaUnknownReason)})` : ""}`;

  if (header.currency === undefined) {
    // No `currency` sibling on this build's /health at all — fall back to
    // the build sha alone, per the ticket's own EITHER-WAY instruction.
    return `<div class="hdrline build">${buildText}</div>`;
  }
  const { checkedAt, verdict } = header.currency;
  const ageStr = checkedAt === null ? "never computed yet" : `checked ${esc(ageText(checkedAt, now))} ago`;
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
  return `<div class="hdrline build">${buildText} · currency: ${esc(verdictText)} (${esc(ageStr)})</div>`;
}

/**
 * The whole-page freshness banner (requirement 1's headline case). Keyed
 * SOLELY on `response.checked` — never on `rows.length` — so a genuinely
 * empty fleet (`checked: true, rows: []`) reads as the calm finding it is,
 * while a failed OR never-yet-run poll (`checked: false`, any `rows.length`)
 * reads as a loud, unmissable banner, distinguishable from "nothing is
 * wrong" even when there is no row left to carry that distinction (mutation
 * 1's whole-response case, and the ticket's own "must never render as an
 * empty, calm page" requirement).
 */
function renderPageBanner(response: DashboardResponse, now: number): string {
  if (response.checked) {
    const rowNote = response.rows.length === 0 ? `<div class="empty">this daemon runs no agents — a genuine finding, not a failure</div>` : "";
    return `<div class="pagefresh known">confirmed ${esc(ageText(response.confirmedAt, now))} ago (at ${esc(response.confirmedAt)})</div>${rowNote}`;
  }
  const rowsNote =
    response.rows.length > 0
      ? "Rows below (if any) are carried forward from the last successful poll and may be stale."
      : 'No rows are available — this is NOT the same as "this daemon runs no agents".';
  return (
    `<div class="pagefresh cnc banner">COULD NOT CHECK — this daemon's agent-list read failed, or has never succeeded yet. ` +
    `Declined ${esc(ageText(response.declinedAt, now))} ago (at ${esc(response.declinedAt)}). ${rowsNote}</div>`
  );
}

const STYLE = `
 body{background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,monospace;margin:0;padding:24px}
 h1{font-size:16px;color:#8b949e;font-weight:600;margin:0 0 12px}
 .hdrline{color:#8b949e;font-size:12px;margin-bottom:6px}
 .pagefresh{font-size:12px;margin-bottom:6px}
 .pagefresh.known{color:#8b949e}
 .pagefresh.cnc.banner{display:block;background:#3a1e12;color:#f0b429;font-size:13px;font-weight:600;padding:10px 12px;border:1px solid #f0b429;border-radius:8px;margin-bottom:12px}
 .admission{font-size:12px;color:#8b949e;margin-bottom:16px;padding:8px 12px;border:1px solid #21262d;border-radius:8px}
 .admcap{margin-bottom:4px}
 .admcap .cnc{color:#f0b429;font-weight:600}
 .admcap .known{color:#c9d1d9}
 .admsrc.cnc{color:#f0b429}
 .admsrc.known{color:#3fb950}
 .admsrc.none{color:#6e7681}
 .row{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid #21262d;border-radius:8px;margin:6px 0;flex-wrap:wrap}
 .row.withheld{border-style:dashed;border-color:#a371f7}
 .key{font-weight:600;color:#58a6ff;min-width:90px}
 .tier{font-size:12px;color:#8b949e}
 .tier.cnc{color:#f0b429;font-weight:600}
 .pane{font-size:12px;color:#8b949e}
 .st{font-size:12px;padding:2px 8px;border-radius:10px}
 .working{background:#132e1a;color:#3fb950}.blocked{background:#3a1e12;color:#e3893a}
 .idle{background:#1b2129;color:#8b949e}.done{background:#161b22;color:#6e7681}.unknown{background:#161b22;color:#6e7681}
 .st.waiting{background:#2d1f47;color:#a371f7}
 .floor{font-size:20px;font-weight:700;color:#c9d1d9}
 .floorval{font-size:20px}
 .inexact{font-size:11px;font-weight:400;color:#e3893a}
 .conf{font-size:11px;color:#6e7681}
 .conf.cnc{color:#f0b429;font-weight:600}
 .na{font-size:12px;color:#6e7681;font-style:italic}
 .link{font-size:12px;color:#58a6ff;text-decoration:none;border:1px solid #30363d;padding:2px 8px;border-radius:6px}
 .link:hover{background:#161b22}
 .empty{color:#6e7681;padding:12px 0}
 .hint{color:#6e7681;font-size:12px;margin-top:16px}
`;

/**
 * THE entry point (BUTCHR-339): pure, synchronous, server-side render of a
 * real `/dashboard` response into a finished HTML page. No I/O, no browser
 * clock — every time-dependent value comes from `opts.now` or the response
 * itself. The route (`src/web/view.ts`) calls this and returns the string
 * as-is; the browser re-fetches the whole page on the `<meta refresh>`
 * interval rather than any client-side re-rendering logic existing to test.
 */
export function renderDashboard(response: DashboardResponse, opts: RenderDashboardOpts): string {
  const stale = !response.checked;
  // Which sources currently report `census.checked === false` — a withheld
  // row's OWN freshness badge goes stale in lockstep with its own source's
  // panel entry (see `renderWithheldRow`'s own doc comment), never any
  // other source's, and never the whole-response `checked` flag.
  const declinedSources = new Set(response.admission.sources.filter((s) => !s.census.checked).map((s) => s.source));
  const rowsHtml = response.rows
    .map((row) => (row.kind === "agent" ? renderAgentRow(row, stale, opts) : renderWithheldRow(row, opts, declinedSources.has(row.source))))
    .join("");
  const refresh = opts.refreshSeconds ?? 5;
  return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="refresh" content="${refresh}"><title>butchr dashboard</title>
<style>${STYLE}</style></head><body>
<h1>butchr — dashboard</h1>
${renderBuildHeader(opts.header, opts.now)}
${renderPageBanner(response, opts.now)}
${renderAdmission(response.admission, opts.now)}
<div id="rows">${rowsHtml}</div>
<div class="hint">"open terminal" attaches a terminal to that agent (fire-and-forget — a launch is not a confirmation a window appeared) · "resource" opens its Jira issue or Confluence project doc · refreshes every ${refresh}s</div>
</body></html>`;
}
