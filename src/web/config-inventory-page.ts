/**
 * FACTORY-81 (story FACTORY-70, epic FACTORY-68) — the "Configurations" view:
 * a pure, synchronous, server-side render of a `QueryAgentInventory`
 * (`../agents/query-agent-inventory.ts`, served as JSON at `GET
 * /config-inventory`) into a finished HTML page. Same discipline as
 * `dashboard-page.ts` (BUTCHR-339): ordinary TypeScript, no `fetch`, no DOM,
 * no clock of its own — every dynamic value is an input, so this module can
 * be driven directly in `test/unit/config-inventory-page.test.ts` against
 * real `QueryAgentInventory` shapes.
 *
 * ADDITIVE, READ-ONLY, NEVER A SPREAD: every field rendered below is read
 * from an inventory entry BY NAME — never `Object.keys`, never a JSON dump
 * of an entry — so an unexpected future field (secret-shaped or not) can
 * never reach the page. See `query-agent-inventory.ts`'s own top comment for
 * why the inventory itself is already secret-free by the same discipline;
 * this module does not re-derive that guarantee, it extends it to rendering.
 *
 * THREE THINGS THIS PAGE MUST NEVER CONFLATE, mirroring `dashboard-page.ts`'s
 * own KNOWN / COULD-NOT-CHECK / NOT-APPLICABLE split, restated for config
 * data rather than agent-status data:
 *   - KNOWN: the field has a real value — rendered plainly (or, for a
 *     notable state like "DISABLED"/"INVALID"/"UNSTAFFED", with the `cnc`
 *     class for visual weight — still a KNOWN fact, just a loud one).
 *   - COULD NOT CHECK (`cnc` class, the literal words "COULD NOT CHECK"):
 *     something this daemon would need to look at could not be read —
 *     originally only a failed fetch of `/config-inventory` itself (the
 *     whole-page banner below); FACTORY-132 extends this to TWO per-row
 *     cases that share the identical cause (the agent census is
 *     unavailable — `RenderConfigInventoryOpts.agentCensusChecked === false`,
 *     the SAME `DashboardResponse.checked` flag `dashboard-page.ts`'s own
 *     page banner keys on): a rule's own staffing cell (`renderRuleRow`) and
 *     the cross-link area of EITHER row kind (`renderAgentLinks`, shared by
 *     `renderRuleRow` and `renderSessionRow` alike). Never rendered as
 *     `UNSTAFFED` or "no running agent" — both of those are claims this
 *     daemon cannot back up while the census is unavailable.
 *   - NOT APPLICABLE (`na` class, an em-dash): an INVALID session
 *     definition's content fields (`vendor`, `tier`, `permissionMode`, …)
 *     structurally do not exist — the file's own content cannot be trusted,
 *     not that a read of it failed (see `SessionDefinitionListEntry`'s own
 *     doc comments for exactly which fields this applies to).
 *   - A rule or session definition with NO running agent (`na` class,
 *     "no running agent") — nothing failed; there is simply no row to link.
 *     Only rendered when the agent census IS available; see COULD NOT CHECK
 *     above for the case where it is not.
 *
 * CROSS-LINKS (`../agents/config-inventory-links.ts`): each rule/session row
 * carries an `id` a running agent row's own back-link points at, and lists
 * links to every matching agent row via `opts.dashboardLinkHref` — the exact
 * inverse of the additive back-link `dashboard-page.ts` now renders.
 */
import { ICON_HEAD_TAGS, ICON_MARK } from "./icons.js";
import type { FileErrorEntry, QueryAgentInventory, RuleInventoryEntry, SessionDefinitionInventoryEntry } from "../agents/query-agent-inventory.js";
import type { AgentDashboardRow, DashboardRow } from "../agents/dashboard.js";
import { agentRowsForRule, agentRowsForSessionDefinition, ruleAnchorId, sessionAnchorId } from "../agents/config-inventory-links.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** NOT-APPLICABLE rendering for a possibly-absent string field — an em-dash, never styled like a known value and never confused with a could-not-check failure (see this module's own top comment). */
function naOr(value: string | undefined): string {
  return value === undefined ? `<span class="na">—</span>` : esc(value);
}

/** Same NOT-APPLICABLE discipline for a possibly-absent boolean field (`manifestFrozen`/`storeFrozen`) — rendered as literal `true`/`false` text (never user data, so no `esc` needed) with a `known`/`na` class carrying the actual value's own weight (frozen is not inherently bad, so no `cnc`). */
function boolOr(value: boolean | undefined): string {
  return value === undefined ? `<span class="na">—</span>` : `<span class="${value ? "known" : "off"}">${value}</span>`;
}

export interface RenderConfigInventoryOpts {
  /** Builds the href for a matched agent row's link back to `/` (`dashboard-page.ts`'s own `agentRowAnchorId`, applied by the caller) — a pure URL builder, same pattern as `RenderDashboardOpts.terminalLinkHref`. */
  dashboardLinkHref: (resourceKey: string) => string;
  /**
   * FACTORY-132: `DashboardResponse.checked` verbatim, from the SAME
   * poll-fed snapshot the caller already passes as this function's own
   * `rows` parameter — never a second, independently-sourced flag, so the
   * matches and the reason an empty match list means what it means always
   * come from one snapshot (see `renderAgentLinks`). REQUIRED, not
   * optional-with-a-default: a caller that forgets to wire this is a
   * compile error, not a silent, wrong "no running agent" while the census
   * is actually unavailable — precisely the defect this ticket fixes. The
   * one existing test helper that builds this type (`config-inventory-
   * page.test.ts`'s own `opts()`) defaults it to `true` (the checked state),
   * which is why every pre-existing "no running agent" / "UNSTAFFED:
   * disabled" assertion in that file still holds unmodified.
   */
  agentCensusChecked: boolean;
  /** Auto-refresh interval in seconds, same convention as `dashboard-page.ts`. Defaults to 5. */
  refreshSeconds?: number;
}

/** The result of the caller's own attempt to read `QueryAgentInventory` — mirrors `ViewDeps.resourceLink`'s `{ok:true,...} | {ok:false,error}` shape rather than throwing through this pure render function. `ok:false` is DoD requirement 4's "also make it visible when a fetch of `/config-inventory` itself fails" — rendered as a loud banner with NO tables below it (an empty table here would read as "no config", which is never the right claim about a failed read). */
export type ConfigInventoryFetchResult = { ok: true; inventory: QueryAgentInventory } | { ok: false; error: string };

/**
 * FACTORY-132: three cases, only the third changed by this ticket — see the
 * module header's COULD NOT CHECK entry. A live match always links,
 * regardless of census state (a stale carry-forward row still links, same
 * as before this ticket). An empty match list means two different things
 * depending on `opts.agentCensusChecked`: with the census available, a
 * genuine "nothing to link to" (`na` class, unchanged from before this
 * ticket); with it unavailable, this daemon cannot say whether a running
 * agent exists at all — rendered `cnc`, and deliberately NOT containing the
 * substring "no running agent", since that specific claim is exactly what
 * is unavailable. Shared verbatim by `renderRuleRow` AND `renderSessionRow`
 * (both call this with the same `opts`), so a disabled rule or an invalid
 * session definition gets the identical could-not-check cross-link
 * treatment as any other row — the flat rule the ticket asks for.
 */
function renderAgentLinks(matches: readonly AgentDashboardRow[], opts: RenderConfigInventoryOpts): string {
  if (matches.length > 0) return matches.map((r) => `<a class="link" href="${esc(opts.dashboardLinkHref(r.resourceKey))}">${esc(r.resourceKey)}</a>`).join(" ");
  if (!opts.agentCensusChecked) return `<span class="cnc">COULD NOT CHECK — the running-agent set could not be checked (agent census unavailable)</span>`;
  return `<span class="na">no running agent</span>`;
}

/**
 * FACTORY-132: `rule.staffed`'s three states, rendered exhaustively —
 * `=== true` / `=== false` / `=== null`, deliberately never a truthiness
 * test on `staffed` (see that field's own doc comment for why: a falsy
 * check would silently render `null` exactly like `false`, i.e. `UNSTAFFED`,
 * recreating this ticket's own defect). `null` renders in the SAME COULD NOT
 * CHECK idiom `renderAgentLinks` uses for the cross-link area — the `cnc`
 * class, and the literal words "COULD NOT CHECK" — and never the word
 * "UNSTAFFED" in any casing.
 */
function renderStaffed(rule: RuleInventoryEntry): { text: string; cls: string } {
  if (rule.staffed === true) return { text: "staffed", cls: "known" };
  const reasonSuffix = rule.reason ? `: ${esc(rule.reason)}` : "";
  if (rule.staffed === false) return { text: `UNSTAFFED${reasonSuffix}`, cls: "cnc" };
  return { text: `COULD NOT CHECK${reasonSuffix}`, cls: "cnc" };
}

/**
 * FACTORY-120: one preference, labeled by its actual RESOLVED value — never
 * a bare `harness/model/effort` slug a reader has to parse, and never the
 * old "(model/effort stand in for tier)" caption (stale since FACTORY-74
 * replaced `tier` with the two-axis scale). `model`/`effort` here are
 * ALREADY resolved (see `RuleInventoryEntry.agentPreferences`'s own doc
 * comment, `../agents/query-agent-inventory.ts`) — this function never
 * touches `../resources/power-scale.ts` itself, and never renders the raw
 * `modelPower`/`effortPower` a rule preference was expressed with: that raw
 * value is dropped at rules-load time and is out of scope for this ticket
 * (see that same doc comment). `"default"` for an absent axis — never
 * blank, never a made-up value: the rule set no preference on that axis, so
 * butchr's global agent config decides at launch time (`agentLaunchConfig`,
 * `../agents/argv.ts`).
 */
function formatPreference(p: RuleInventoryEntry["agentPreferences"][number]): string {
  return `${p.harness} — Model: ${p.model ?? "default"} · Effort: ${p.effort ?? "default"}`;
}

/**
 * Requirement 1's exact field list. `agentPreferences` is rendered via
 * `formatPreference` above — never a bare `tier` field, which
 * `RuleInventoryEntry` structurally does not have (see that type's own
 * doc comment). Disabled rules render with the SAME row shape as enabled
 * ones, just the `disabled` class and `DISABLED` text — never hidden,
 * per requirement 1's own "disabled rules must be visible".
 */
function renderRuleRow(rule: RuleInventoryEntry, rows: readonly DashboardRow[], opts: RenderConfigInventoryOpts): string {
  const agentRows = agentRowsForRule(rule, rows);
  const prefs = rule.agentPreferences.length === 0 ? "—" : rule.agentPreferences.map(formatPreference).join(", ");
  const staffed = renderStaffed(rule);
  return (
    `<div class="row rule${rule.enabled ? "" : " disabled"}" id="${esc(ruleAnchorId(rule.resourceProvider, rule.id))}">` +
    `<span class="key">${esc(rule.id)}</span>` +
    `<span class="provider">${esc(rule.resourceProvider)}</span>` +
    `<span class="query">${esc(rule.query)}</span>` +
    `<span class="enabled ${rule.enabled ? "known" : "cnc"}">${rule.enabled ? "enabled" : "DISABLED"}</span>` +
    `<span class="exec">${esc(rule.execution)}</span>` +
    `<span class="prefs">${esc(prefs)}</span>` +
    `<span class="linked">linked-eventing: ${rule.linkedEventing ? "on" : "off"}</span>` +
    `<span class="staffed ${staffed.cls}">${staffed.text}</span>` +
    `<div class="agentlinks">${renderAgentLinks(agentRows, opts)}</div>` +
    `</div>`
  );
}

/**
 * Requirement 2's exact field list, uniformly for every entry (valid or not,
 * archived or not) — an INVALID entry simply renders its content fields
 * NOT-APPLICABLE (`naOr`) rather than switching to a different layout, so a
 * reader scanning the column of (say) `workingDirectory` values sees one
 * consistent shape whether or not this particular row's file parsed.
 * `problems` renders only when non-empty (always empty for a valid entry).
 */
function renderSessionRow(entry: SessionDefinitionInventoryEntry, rows: readonly DashboardRow[], opts: RenderConfigInventoryOpts): string {
  const agentRows = agentRowsForSessionDefinition(entry, rows);
  const idAttr = entry.agentKey !== undefined ? ` id="${esc(sessionAnchorId(entry.agentKey))}"` : "";
  // FACTORY-120: a `tier`-based (deprecated) entry keeps rendering
  // `vendor/tier` (e.g. "claude/tier1") exactly as before. A modelPower/effort
  // (two-axis) entry has no `tier` to show here — rendering `vendor/?` was
  // the visible defect this ticket fixes, so that case shows the vendor
  // alone instead of inventing a "?" placeholder; the new `resolvedagent`
  // span below is where its axis information actually lives now.
  const vendorTier = entry.vendor === undefined ? undefined : entry.tier !== undefined ? `${entry.vendor}/${entry.tier}` : entry.vendor;
  // Labeled as the actual resolved value — never a bare model string a
  // reader has to guess the meaning of. `undefined` (renders NOT-APPLICABLE,
  // `naOr`) exactly when `resolvedModel` itself is absent (an INVALID entry) —
  // see `SessionDefinitionInventoryEntry.resolvedModel`'s own doc comment.
  // A `tier`-based entry resolves to no effort BY DESIGN (`effectiveAgent`'s
  // own doc comment, `../resources/session-definition.ts`) — that is a KNOWN
  // fact (the daemon's own launch default applies), not a not-applicable
  // em-dash, so it gets its own honest wording rather than falling through
  // to `naOr`.
  const resolvedAgent =
    entry.resolvedModel !== undefined ? `Model: ${entry.resolvedModel} · Effort: ${entry.resolvedEffort ?? "no effort set — launch default applies"}` : undefined;
  // The raw 0-100 input, shown as SECONDARY detail alongside the resolved
  // value above, never in place of it. Absent for a `tier`-based (deprecated)
  // definition, which has no `modelPower`/`effort` axis at all.
  const rawPowerParts: string[] = [];
  if (entry.modelPower !== undefined) rawPowerParts.push(`modelPower ${entry.modelPower}`);
  if (entry.effort !== undefined) rawPowerParts.push(`effort ${entry.effort}`);
  const rawPower = rawPowerParts.length > 0 ? rawPowerParts.join(", ") : undefined;
  const mcp = entry.mcpServerNames === undefined ? undefined : entry.mcpServerNames.length === 0 ? "none" : entry.mcpServerNames.join(", ");
  const freezeCtl = entry.freezeControllers === undefined ? undefined : entry.freezeControllers.length === 0 ? "none" : entry.freezeControllers.join(", ");
  const unfreezeCtl = entry.unfreezeControllers === undefined ? undefined : entry.unfreezeControllers.length === 0 ? "none" : entry.unfreezeControllers.join(", ");
  const problemsHtml = entry.problems.length > 0 ? `<div class="problems">${entry.problems.map((p) => `<div class="problem">${esc(p)}</div>`).join("")}</div>` : "";
  return (
    `<div class="row session${entry.archived ? " archived" : ""}${entry.valid ? "" : " invalid"}"${idAttr}>` +
    `<span class="key">${esc(entry.name)}</span>` +
    `<span class="archived ${entry.archived ? "known" : "na"}">${entry.archived ? "ARCHIVED" : "active"}</span>` +
    `<span class="validity ${entry.valid ? "known" : "cnc"}">${entry.valid ? "valid" : "INVALID"}</span>` +
    `<span class="vendortier">${naOr(vendorTier)}</span>` +
    `<span class="resolvedagent">${naOr(resolvedAgent)}</span>` +
    `<span class="rawpower">raw: ${naOr(rawPower)}</span>` +
    `<span class="permmode">${naOr(entry.permissionMode)}</span>` +
    `<span class="exec">${naOr(entry.execution)}</span>` +
    `<span class="account">${naOr(entry.account)}</span>` +
    `<span class="role">${naOr(entry.role)}</span>` +
    `<span class="workdir">${naOr(entry.workingDirectory)}</span>` +
    `<span class="mcp">mcp: ${naOr(mcp)}</span>` +
    `<span class="manifestfrozen">manifestFrozen: ${boolOr(entry.manifestFrozen)}</span>` +
    `<span class="storefrozen">storeFrozen: ${boolOr(entry.storeFrozen)}</span>` +
    `<span class="freezectl">freeze: ${naOr(freezeCtl)}</span>` +
    `<span class="unfreezectl">unfreeze: ${naOr(unfreezeCtl)}</span>` +
    problemsHtml +
    `<div class="agentlinks">${renderAgentLinks(agentRows, opts)}</div>` +
    `</div>`
  );
}

/** Requirement 4's "everything in `errors[]` is displayed prominently" — `""` (nothing rendered, not even an empty container) when there are none, so an empty `errors[]` never shows a hollow "0 errors" banner. */
function renderErrors(errors: readonly FileErrorEntry[]): string {
  if (errors.length === 0) return "";
  return (
    `<div class="errors banner">` +
    `<div class="errtitle">${errors.length} configuration load/parse error(s):</div>` +
    errors.map((e) => `<div class="err"><span class="errpath">${esc(e.path)}</span>: <span class="errmsg">${esc(e.message)}</span></div>`).join("") +
    `</div>`
  );
}

const STYLE = `
 body{background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,monospace;margin:0;padding:24px}
 h1{font-size:16px;color:#8b949e;font-weight:600;margin:0 0 12px}
 h2{font-size:14px;color:#8b949e;font-weight:600;margin:20px 0 8px}
 .fetchfail{display:block;background:#3a1e12;color:#f0b429;font-size:13px;font-weight:600;padding:10px 12px;border:1px solid #f0b429;border-radius:8px;margin-bottom:12px}
 .errors.banner{background:#3a1e12;color:#f0b429;font-size:12px;padding:10px 12px;border:1px solid #f0b429;border-radius:8px;margin-bottom:16px}
 .errtitle{font-weight:600;margin-bottom:4px}
 .err{margin:2px 0}
 .row{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid #21262d;border-radius:8px;margin:6px 0;flex-wrap:wrap}
 .row.disabled{border-style:dashed;opacity:0.75}
 .row.archived{border-color:#a371f7}
 .row.invalid{border-color:#f0b429}
 .key{font-weight:600;color:#58a6ff;min-width:90px}
 .provider,.exec,.account,.role,.permmode,.workdir,.query{font-size:12px;color:#8b949e}
 .known{color:#3fb950}
 .cnc{color:#f0b429;font-weight:600}
 .off{color:#6e7681}
 .na{font-size:12px;color:#6e7681;font-style:italic}
 .problems{width:100%;font-size:12px;color:#f0b429}
 .problem{margin:2px 0}
 .agentlinks{width:100%;font-size:12px}
 .link{font-size:12px;color:#58a6ff;text-decoration:none;border:1px solid #30363d;padding:2px 8px;border-radius:6px}
 .link:hover{background:#161b22}
 .empty{color:#6e7681;padding:12px 0}
`;

/**
 * THE entry point: pure, synchronous, server-side render of a
 * `QueryAgentInventory` fetch attempt into a finished HTML page. `rows` is
 * the SAME poll-fed `DashboardResponse.rows` `/dashboard`/`/` already serve
 * — passed in, never fetched by this module — used only for the cross-link
 * matching (`agentRowsForRule`/`agentRowsForSessionDefinition`).
 */
export function renderConfigInventory(result: ConfigInventoryFetchResult, rows: readonly DashboardRow[], opts: RenderConfigInventoryOpts): string {
  const refresh = opts.refreshSeconds ?? 5;
  const body = result.ok
    ? (() => {
        const inv = result.inventory;
        const rulesHtml = inv.rules.length === 0 ? `<div class="empty">no rules configured</div>` : inv.rules.map((r) => renderRuleRow(r, rows, opts)).join("");
        const sessionsHtml =
          inv.sessionDefinitions.length === 0
            ? `<div class="empty">no managed-session definitions configured</div>`
            : inv.sessionDefinitions.map((e) => renderSessionRow(e, rows, opts)).join("");
        return (
          renderErrors(inv.errors) +
          `<h2>Rules</h2><div id="rules">${rulesHtml}</div>` +
          `<h2>Managed-session definitions</h2><div id="sessions">${sessionsHtml}</div>`
        );
      })()
    : `<div class="fetchfail">COULD NOT CHECK — fetching /config-inventory failed: ${esc(result.error)}. Nothing below reflects real configuration; this is NOT the same as "no configuration exists".</div>`;
  return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="refresh" content="${refresh}"><title>butchr configurations</title>${ICON_HEAD_TAGS}
<style>${STYLE}</style></head><body>
<h1>${ICON_MARK}butchr — configurations</h1>
${body}
<div class="hint">read-only view of every configured query agent (rules + managed-session definitions), staffed or not · refreshes every ${refresh}s · <a class="link" href="/">back to agents</a></div>
</body></html>`;
}
