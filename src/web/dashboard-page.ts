/**
 * BUTCHR-339: the butchr dashboard PAGE — a pure, synchronous, server-side
 * render of the real `/dashboard` response (`src/agents/dashboard.ts`), one
 * row per agent, exactly two links (terminal attach, resource), and no I/O
 * of its own.
 *
 * WHY THIS EXISTS AS A SEPARATE MODULE FROM `src/web/page.ts`: that file is a
 * template string with the rendering logic inside BROWSER JavaScript —
 * nothing in that design can be unit-tested. This module is the opposite:
 * ordinary TypeScript, no `Date.now()`, no fetch, no DOM — `now` and every
 * other time-dependent input are passed in, so `test/unit/dashboard-page.test.ts`
 * can drive it directly against response shapes the real endpoint produces
 * and assert on the returned HTML string.
 *
 * THE TWO ABSENCES THIS RENDER FUNCTION MUST NEVER CONFLATE (the ticket's
 * own framing, repeated here because it is the module's entire job):
 *   - KNOWN: the value is there — rendered plainly, no warning styling.
 *   - COULD NOT CHECK: a read failed, was untrusted, or has never happened —
 *     rendered with the `cnc` class, and the literal words "could not check"
 *     somewhere in its text, never styled like a known value.
 *
 * FACTORY-1013: a THIRD absence ("not applicable" — a withheld row's missing
 * agent, under the deleted capacity admission cap) is gone with the cap
 * itself. There are no agentless rows any more: every matched resource is
 * reconciled into its agent, so the admission panel, the withheld row kind
 * and the `na` marker were all removed rather than left rendering a figure
 * nothing produces.
 *
 * NEVER A JIRA LABEL: this module imports nothing from `src/labels/*` and
 * never will — every status/tier value it renders comes from the
 * `DashboardResponse` it's handed, which is itself fed from herdr's own
 * agent list (see `src/agents/dashboard.ts`'s header). That is deliberate:
 * the simplest way to guarantee mutation 8 ("any status filled from a Jira
 * label") never happens is to make it a missing import, not a discipline.
 */
import { ICON_HEAD_TAGS, ICON_MARK } from "./icons.js";
import type { DashboardResponse, AgentDashboardRow, TierField } from "../agents/dashboard.js";
import type { StatusFloor } from "../agents/status-floor.js";
import { humanDuration } from "../agents/status-floor.js";
import type { CurrencyReport } from "../daemon/currency.js";
import { agentRowAnchorId, configAnchorForResourceKey } from "../agents/config-inventory-links.js";
import { decodeAnyAgentKey } from "../rules/agent-key.js";

/** The subset of `BuildReport` (src/agents/build-identity.ts) this header actually reads — kept narrow so a test fixture doesn't have to fabricate herdr's full shape. */
export interface DashboardBuildInfo {
  sha: string | null;
  shaDirty: boolean | null;
  shaUnknownReason: string | null;
  version: string;
  /** FACTORY-627: "tag" (the live, latest-v*-tag-derived number) vs "package-json" (the frozen fallback) — see `VersionResult` (src/agents/build-identity.ts) for why these can differ. */
  versionProvenance: "tag" | "package-json";
  /** Set iff `versionProvenance` is "package-json" — WHY no tag-derived version was available. */
  versionUnknownReason: string | null;
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
  /**
   * FACTORY-81: builds the Configurations-view href for an agent row's
   * additive back-link, given the anchor `../agents/config-inventory-links.js`'s
   * `configAnchorForResourceKey` computed for that row — a pure URL builder,
   * same pattern as `terminalLinkHref`/`resourceLinkHref` above, so adding
   * this back-link adds NO I/O to `/`'s existing no-fetch-of-its-own request
   * path (see that link function's own top comment for why it needs no
   * inventory in hand to do this). Defaults to `/configurations#<anchor>` —
   * existing tests that never pass this keep working unchanged.
   */
  configLinkHref?: (anchor: string) => string;
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

/** The page/row freshness badge. `stale` (the RESPONSE's own `checked === false`) changes both the wording and the class: a carried-forward row must read "at least X, as of <its own confirmedAt>" and never look like a fresh, current confirmation (mutation 5's row-level twin, and the ticket's own explicit wording). */
function renderFreshness(iso: string, now: number, stale: boolean, verb: string): string {
  const age = ageText(iso, now);
  if (stale) {
    return `<span class="conf cnc" title="${esc(iso)}">STALE — at least ${esc(age)} old, as of ${esc(iso)}</span>`;
  }
  return `<span class="conf known" title="${esc(iso)}">${esc(verb)} ${esc(age)} ago</span>`;
}

/**
 * FACTORY-81: the additive back-link this ticket's requirement 3 asks for —
 * `null` (nothing rendered) only when `resourceKey` fails to decode at all,
 * which nothing in this daemon produces today (see `configAnchorForResourceKey`'s
 * own doc comment). The link always POINTS somewhere real even for a rule
 * this daemon's current config no longer has an entry for (e.g. a rule
 * removed from `rules.json` after this agent was spawned) — the anchor is
 * built from the resourceKey's own decoded parts, not a lookup against a
 * live inventory, so a stale link simply lands on a Configurations page with
 * no matching row, never a broken href.
 */
function renderConfigBackLink(resourceKey: string, opts: RenderDashboardOpts): string {
  const anchor = configAnchorForResourceKey(resourceKey);
  if (anchor === null) return "";
  const href = opts.configLinkHref ? opts.configLinkHref(anchor) : `/configurations#${anchor}`;
  return `<a class="link" href="${esc(href)}">config</a>`;
}

/**
 * FACTORY-408: the visible row label — a REGRESSION FIX, not a new
 * decision. `AgentDashboardRow.resourceKey` (FACTORY-407) is the full
 * `<resourceProvider>:<ruleId>:<resourceId>` key, needed for correlation,
 * hrefs, and anchors, but this is what a person actually reads on `/` and
 * `/dashboard` — it must decode back to the bare provider-native resource
 * id a person saw before FACTORY-407 widened `resourceKey` (e.g. `FACTORY-68`,
 * never `jira-work:epics:FACTORY-68`).
 *
 * A query-level agent (`kind: "query"`, `decodeAnyAgentKey`) has no single
 * resource to name — its OWN full key was always a slightly odd thing to
 * show verbatim, even before this key's format grew tied to correlation —
 * so this renders `<resourceProvider>:<ruleId> (query)` instead: readable,
 * and distinct from an ordinary bare resource id so a reader never mistakes
 * one for the other.
 *
 * `null` (nothing this daemon produces for an owned agent today, same
 * defensive case `buildTier` in `src/agents/dashboard.ts` guards) falls
 * back to the raw key rather than throwing — this is a display function,
 * never the source of a crash.
 */
function displayResourceKey(resourceKey: string): string {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (decoded === null) return resourceKey;
  return decoded.kind === "resource" ? decoded.resourceId : `${decoded.resourceProvider}:${decoded.ruleId} (query)`;
}

function renderAgentRow(row: AgentDashboardRow, stale: boolean, opts: RenderDashboardOpts): string {
  const tier = renderTier(row.tier);
  return (
    `<div class="row agent" id="${esc(agentRowAnchorId(row.resourceKey))}">` +
    `<span class="key">${esc(displayResourceKey(row.resourceKey))}</span>` +
    `<span class="tier ${tier.cnc ? "cnc" : "known"}">${tier.cnc ? "COULD NOT CHECK" : esc(tier.text)}</span>` +
    `<span class="st ${safeClass(row.agentStatus)}">${esc(row.agentStatus)}</span>` +
    `<span class="pane">${esc(row.pane)}</span>` +
    renderFloor(row.timeInStatus, opts.now, `in status "${row.agentStatus}"`) +
    renderFreshness(row.confirmedAt, opts.now, stale, "confirmed") +
    `<a class="link" href="${esc(opts.terminalLinkHref(row.pane))}">open terminal</a>` +
    `<a class="link" href="${esc(opts.resourceLinkHref(row.resourceKey))}">resource</a>` +
    renderConfigBackLink(row.resourceKey, opts) +
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
  const versionText = build
    ? `${esc(build.version)}${build.versionProvenance === "package-json" ? ` (package.json fallback${build.versionUnknownReason ? `: ${esc(build.versionUnknownReason)}` : ""})` : ""}`
    : "";
  const buildText = build?.sha
    ? `build ${esc(build.sha.slice(0, 8))}${build.shaDirty === true ? " (dirty)" : build.shaDirty === false ? " (clean)" : ""} · version ${versionText}`
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
 .row{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid #21262d;border-radius:8px;margin:6px 0;flex-wrap:wrap}
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
 *
 * FACTORY-81 review fix: the page's own `.hint` line ALWAYS carries a link to
 * `/configurations`, regardless of `rows` — a config entry with no live
 * agent (a disabled rule, an unstaffed rule, an archived session) has no
 * per-row back-link at all, and the whole point of the Configurations view
 * is to show exactly those, so an operator on an empty `/` must still have
 * a way in that isn't typing the URL by hand.
 */
export function renderDashboard(response: DashboardResponse, opts: RenderDashboardOpts): string {
  const stale = !response.checked;
  const rowsHtml = response.rows.map((row) => renderAgentRow(row, stale, opts)).join("");
  const refresh = opts.refreshSeconds ?? 5;
  return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="refresh" content="${refresh}"><title>butchr dashboard</title>${ICON_HEAD_TAGS}
<style>${STYLE}</style></head><body>
<h1>${ICON_MARK}butchr — dashboard</h1>
${renderBuildHeader(opts.header, opts.now)}
${renderPageBanner(response, opts.now)}
<div id="rows">${rowsHtml}</div>
<div class="hint">"open terminal" attaches a terminal to that agent (fire-and-forget — a launch is not a confirmation a window appeared) · "resource" opens its Jira issue or Confluence project doc · refreshes every ${refresh}s · <a class="link" href="/configurations">configurations</a></div>
</body></html>`;
}
